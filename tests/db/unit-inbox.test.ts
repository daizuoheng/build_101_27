// Bandeja de unidad (Tarea 12, lado Recepción). `transitionAssignment` es un doble SIMULADO que respeta el contrato
// (ASSIGNMENT_TRANSITIONS + versión); la implementación real y sus tests de concurrencia son de Operación.
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { seedDemo } from "../../seeds/demo";
import { withTx } from "@/server/db/tx";
import type { TransitionAssignment } from "@/server/contracts";
import { conflict, forbidden } from "@/server/errors";
import { appendCitizenMessage, createDraft, setLocation } from "@/server/intake/drafts";
import { confirmReport } from "@/server/intake/confirm";
import { runIntakeTurn } from "@/server/intake/orchestrator";
import { handlers } from "@/server/jobs/handlers";
import { runOnce } from "@/server/jobs/worker-loop";
import { performUnitAction } from "@/server/unit/actions";
import { getUnitInbox } from "@/server/unit/inbox";
import { getUnitPhoto } from "@/server/unit/photos";
import { getOwnPhoto } from "@/server/intake/photos";
import { ASSIGNMENT_TRANSITIONS } from "@/shared/contracts/assignment";
import { fakeJev, memoryStorage, newSession, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

const POINT = { lon: -56.1993, lat: -34.9068 };

function fakeTransition(): TransitionAssignment & { calls: number } {
  const fn = async (c: PoolClient, input: Parameters<TransitionAssignment>[1]) => {
    fn.calls++;
    const { rows } = await c.query<{ status: string; version: number; unit_id: string }>(
      "select status, version, unit_id from assignments where id = $1 for update",
      [input.assignmentId],
    );
    const a = rows[0];
    if (input.actor.unitId !== a.unit_id) throw forbidden();
    if (a.version !== input.expectedVersion) throw conflict("version_conflict", "La orden cambió.");
    const t = ASSIGNMENT_TRANSITIONS[input.action];
    if (!t.from.includes(a.status as never)) throw conflict("invalid_transition", "Transición inválida.");
    const upd = await c.query<{ status: string; version: number }>(
      "update assignments set status = $2, version = version + 1 where id = $1 returning status, version",
      [input.assignmentId, t.to],
    );
    return { assignmentId: input.assignmentId, ...upd.rows[0] };
  };
  fn.calls = 0;
  return fn;
}

async function setupAssignment() {
  const pool = await testDb();
  const t = await territoryId(pool);
  const s = await newSession(pool);
  const deps = testDeps(pool, fakeJev());
  const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
  await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: "Pozo enorme frente a la plaza" }), pool);
  await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...POINT, source: "map", text: "Plaza Independencia" }), pool);
  await runIntakeTurn(deps, id);
  await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
  await runOnce(deps, handlers, { workerId: "test" });

  const units = await pool.query<{ id: string; slug: string }>("select id, slug from response_units order by slug");
  const vial = units.rows.find((u) => u.slug === "cuadrilla-vial")!;
  const other = units.rows.find((u) => u.slug !== "cuadrilla-vial")!;
  const user = await pool.query<{ id: string }>("select id from internal_users where response_unit_id = $1", [vial.id]);
  const inc = await pool.query<{ id: string }>("select id from incidents");
  const a = await pool.query<{ id: string }>(
    `insert into assignments (incident_id, unit_id, distance_m, reasons) values ($1, $2, 420, '["nearest_mobile"]') returning id`,
    [inc.rows[0].id, vial.id],
  );
  return { pool, unitId: vial.id, otherUnitId: other.id, userId: user.rows[0].id, assignmentId: a.rows[0].id };
}

describe("bandeja de unidad", () => {
  beforeEach(async () => {
    process.env.DEMO_OPERATOR_PASSWORD ??= "test-operador";
    process.env.DEMO_UNIT_PASSWORD ??= "test-unidad";
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    await seedDemo(pool, "montevideo");
  });

  it("devuelve la orden con la evidencia original y solo las acciones válidas", async () => {
    const { pool, unitId, otherUnitId } = await setupAssignment();
    const inbox = await getUnitInbox(pool, unitId);
    expect(inbox.unit).toMatchObject({ id: unitId, activeOrders: 1 });
    expect(inbox.assignments).toHaveLength(1);
    const card = inbox.assignments[0];
    expect(card).toMatchObject({ status: "offered", version: 1, allowedActions: ["accept", "reject"], distanceM: 420, reasons: ["nearest_mobile"] });
    expect(card.incident).toMatchObject({ areaName: "CIUDAD VIEJA", citizenTexts: ["Pozo enorme frente a la plaza"], photoIds: [], problemType: "Bache" });
    expect(card.incident.lat).toBeCloseTo(POINT.lat, 5);

    expect((await getUnitInbox(pool, otherUnitId)).assignments).toHaveLength(0);
  });

  it("aceptar con clave repetida no transiciona dos veces", async () => {
    const { pool, unitId, userId, assignmentId } = await setupAssignment();
    const transitionAssignment = fakeTransition();
    const body = { action: "accept" as const, expectedVersion: 1, idempotencyKey: "act-00000001" };
    const run = () => withTx((c) => performUnitAction(c, { transitionAssignment }, { assignmentId, unitId, userId, body }), pool);

    const [a, b] = await Promise.all([run(), run()]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a).toMatchObject({ status: "accepted", version: 2 });
    expect(b).toMatchObject({ status: "accepted", version: 2 });
    expect(transitionAssignment.calls).toBe(1);

    const card = (await getUnitInbox(pool, unitId)).assignments[0];
    expect(card).toMatchObject({ status: "accepted", allowedActions: ["reject", "start"] });
  });

  it("otra unidad no puede actuar sobre la orden (403) y la clave no se puede reutilizar para otra acción (409)", async () => {
    const { pool, unitId, otherUnitId, userId, assignmentId } = await setupAssignment();
    const transitionAssignment = fakeTransition();
    const act = (unit: string, action: "accept" | "reject", key: string) =>
      withTx((c) => performUnitAction(c, { transitionAssignment }, { assignmentId, unitId: unit, userId, body: { action, expectedVersion: 1, idempotencyKey: key } }), pool);

    await expect(act(otherUnitId, "accept", "act-00000002")).rejects.toMatchObject({ status: 403 });
    expect(transitionAssignment.calls).toBe(0);

    await act(unitId, "accept", "act-00000003");
    await expect(act(unitId, "reject", "act-00000003")).rejects.toMatchObject({ status: 409, code: "idempotency_key_reused" });
  });

  it("versión vieja ⇒ 409 del dominio y no se registra la acción", async () => {
    const { pool, unitId, userId, assignmentId } = await setupAssignment();
    const transitionAssignment = fakeTransition();
    await pool.query("update assignments set version = 5 where id = $1", [assignmentId]);
    await expect(
      withTx((c) => performUnitAction(c, { transitionAssignment }, { assignmentId, unitId, userId, body: { action: "accept", expectedVersion: 1, idempotencyKey: "act-00000004" } }), pool),
    ).rejects.toMatchObject({ status: 409 });
    const ev = await pool.query("select count(*)::int as n from events where kind = 'unit_action'");
    expect(ev.rows[0].n).toBe(0);
  });

  it("fotos: la unidad de la orden activa ve el derivado JPEG; otra unidad o una orden cerrada ⇒ 404", async () => {
    const { pool, unitId, otherUnitId, assignmentId } = await setupAssignment();
    const storage = memoryStorage();
    const r = await pool.query<{ id: string }>("select report_id as id from report_incident_links where active limit 1");
    const orig = await pool.query<{ id: string }>(
      `insert into attachments (report_id, storage_key, content_type, bytes, sha256, purpose) values ($1, 'k-orig', 'image/heic', 3, 'a', 'original') returning id`,
      [r.rows[0].id],
    );
    await pool.query(
      `insert into attachments (report_id, storage_key, content_type, bytes, sha256, purpose, derived_from_id) values ($1, 'k-jev', 'image/jpeg', 3, 'b', 'jev', $2)`,
      [r.rows[0].id, orig.rows[0].id],
    );
    await storage.put("k-jev", Buffer.from("jpg"), "image/jpeg");

    expect((await getUnitInbox(pool, unitId)).assignments[0].incident.photoIds).toEqual([orig.rows[0].id]);
    expect((await getUnitPhoto(pool, storage, { unitId, attachmentId: orig.rows[0].id })).toString()).toBe("jpg");
    await expect(getUnitPhoto(pool, storage, { unitId: otherUnitId, attachmentId: orig.rows[0].id })).rejects.toMatchObject({ status: 404 });
    await pool.query("update assignments set status = 'completed' where id = $1", [assignmentId]);
    await expect(getUnitPhoto(pool, storage, { unitId, attachmentId: orig.rows[0].id })).rejects.toMatchObject({ status: 404 });
  });

  it("foto del borrador: solo para la sesión dueña", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    const s = await newSession(pool);
    const other = await newSession(pool);
    const storage = memoryStorage();
    const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
    const orig = await pool.query<{ id: string }>(
      `insert into attachments (report_id, storage_key, content_type, bytes, sha256, purpose) values ($1, 'o', 'image/heic', 1, 'a', 'original') returning id`,
      [id],
    );
    await pool.query(
      `insert into attachments (report_id, storage_key, content_type, bytes, sha256, purpose, derived_from_id) values ($1, 'j', 'image/jpeg', 1, 'b', 'jev', $2)`,
      [id, orig.rows[0].id],
    );
    await storage.put("j", Buffer.from("jpg"), "image/jpeg");
    expect((await getOwnPhoto(pool, storage, { reportId: id, sessionId: s, attachmentId: orig.rows[0].id })).toString()).toBe("jpg");
    await expect(getOwnPhoto(pool, storage, { reportId: id, sessionId: other, attachmentId: orig.rows[0].id })).rejects.toMatchObject({ status: 403 });
    await expect(getOwnPhoto(pool, storage, { reportId: id, sessionId: s, attachmentId: "00000000-0000-0000-0000-000000000000" })).rejects.toMatchObject({ status: 404 });
  });

  it("órdenes cerradas salen de la bandeja; review_blocked impide iniciar", async () => {
    const { pool, unitId, assignmentId } = await setupAssignment();
    await pool.query("update assignments set status = 'accepted', review_blocked = true where id = $1", [assignmentId]);
    expect((await getUnitInbox(pool, unitId)).assignments[0].allowedActions).toEqual(["reject"]);
    await pool.query("update assignments set status = 'completed' where id = $1", [assignmentId]);
    const inbox = await getUnitInbox(pool, unitId);
    expect(inbox.assignments).toHaveLength(0);
    expect(inbox.unit.activeOrders).toBe(0);
  });
});
