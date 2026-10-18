// Detalle del incidente para el operador (Tarea 14, Task 2): contrato, fotos por territorio, correcciones idempotentes
// y rutas. La sesión del operador se simula (vi.mock); el resto corre contra la base de test real.
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedAll } from "../../seeds";
import { seedDemo } from "../../seeds/demo";
import { seedTerritoryDemoB } from "../../seeds/territory-demo-b";
import { withTx } from "@/server/db/tx";
import { appendEvent } from "@/server/events/append";
import { getIncidentDetail } from "@/server/incidents/detail";
import { linkReport } from "@/server/incidents/links";
import { getOperatorPhoto } from "@/server/incidents/operator-photo";
import { requestLink, requestRemoveOverride, requestSetOverride } from "@/server/incidents/operator-requests";
import { setOverride } from "@/server/incidents/overrides";
import { handlers } from "@/server/jobs/handlers";
import { runOnce } from "@/server/jobs/worker-loop";
import { openReviewItem } from "@/server/review/items";
import type { InternalSession } from "@/server/access/internal-session";
import { IncidentDetailResponse } from "@/shared/contracts/incident-detail";
import { confirmedReport, fakeJev, memoryStorage, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

// Las rutas leen la sesión de la cookie y usan getPool(): acá la sesión es la del test y el pool, el de la base de test.
const h = vi.hoisted(() => ({ session: null as InternalSession | null, pool: null as Pool | null }));
vi.mock("@/server/access/internal-session", async (orig) => {
  const actual = await orig<typeof import("@/server/access/internal-session")>();
  return {
    ...actual,
    requireOperatorSession: async () => {
      if (!h.session) throw new (await import("@/server/errors")).DomainError("unauthorized", 401, "Iniciá sesión.");
      return h.session;
    },
  };
});
vi.mock("@/server/db/pool", async (orig) => {
  const actual = await orig<typeof import("@/server/db/pool")>();
  return { ...actual, getPool: () => h.pool ?? actual.getPool() };
});

const { GET: getDetailRoute } = await import("@/app/api/operacion/incidents/[id]/route");
const { POST: postOverrideRoute } = await import("@/app/api/operacion/incidents/[id]/overrides/route");
const { DELETE: deleteOverrideRoute } = await import("@/app/api/operacion/incidents/[id]/overrides/[field]/route");
const { POST: postLinkRoute } = await import("@/app/api/operacion/incidents/[id]/links/route");

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) }) as never;
const json = (url: string, method: string, body: unknown) =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never;

const one = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const revisionOf = async (pool: Pool, id: string) => (await one(pool, "select revision from incidents where id = $1", [id])).revision as number;

type Fixture = { pool: Pool; mvd: string; b: string; operatorId: string; incidentId: string; autoReport: string; manualReport: string; assignmentId: string; photoId: string };

/** Incidente con dos reportes (uno auto y uno manual), corrección de severidad, orden ofrecida, ítem abierto y una foto. */
async function fixture(): Promise<Fixture> {
  const pool = await testDb();
  const mvd = await territoryId(pool);
  const b = await territoryId(pool, "demo-b");
  const operatorId = (await one(pool, "select id from internal_users where role = 'operator' and territory_id = $1 limit 1", [mvd])).id as string;
  const operator = { type: "operator" as const, id: operatorId };
  const jev = fakeJev();

  const autoReport = await confirmedReport(pool, mvd);
  await runOnce(testDeps(pool, jev), handlers, { workerId: "test" }); // crea el incidente (vínculo auto)
  const incidentId = (await one(pool, "select incident_id from report_incident_links where report_id = $1 and active", [autoReport])).incident_id as string;

  const manualReport = await confirmedReport(pool, mvd, "Sigue el pozo, ahora más grande");
  await pool.query("update reports set processing = 'done', outcome = 'applicable' where id = $1", [manualReport]);
  await pool.query("update jobs set status = 'done' where kind = 'process_report'");
  await withTx((c) => linkReport(c, { reportId: manualReport, incidentId, origin: "manual", actor: operator }), pool);

  await withTx(async (c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "riesgo visto en el lugar", actor: operator, expectedRevision: await revisionOf(pool, incidentId) }), pool);

  const unit = await one(pool, "select id, name from response_units where territory_id = $1 order by slug limit 1", [mvd]);
  const assignmentId = (await one(pool, "insert into assignments (incident_id, unit_id) values ($1, $2) returning id", [incidentId, unit.id])).id as string;
  await appendEvent(pool, { entityType: "assignment", entityId: assignmentId, kind: "offered", actorType: "system" });
  await openReviewItem(pool, { territoryId: mvd, kind: "contradiction", entityType: "incident", entityId: incidentId, reasons: [{ code: "reports_inconsistent" }] });

  const orig = await one(pool, "insert into attachments (report_id, storage_key, content_type, bytes, sha256, purpose) values ($1, 'k-orig', 'image/heic', 3, 'a', 'original') returning id", [autoReport]);
  await pool.query("insert into attachments (report_id, storage_key, content_type, bytes, sha256, purpose, derived_from_id) values ($1, 'k-jev', 'image/jpeg', 3, 'b', 'jev', $2)", [autoReport, orig.id]);
  return { pool, mvd, b, operatorId, incidentId, autoReport, manualReport, assignmentId, photoId: orig.id };
}

const session = (f: Fixture, territory = f.mvd): InternalSession => ({ userId: f.operatorId, role: "operator", territoryId: territory, responseUnitId: null, username: "op" });

describe("detalle del incidente para el operador", () => {
  beforeEach(async () => {
    process.env.DEMO_OPERATOR_PASSWORD ??= "test-operador";
    process.env.DEMO_UNIT_PASSWORD ??= "test-unidad";
    const pool = await testDb();
    h.pool = pool;
    h.session = null;
    await resetDb(pool);
    await seedAll(pool);
    await seedDemo(pool, "montevideo");
    await seedTerritoryDemoB(pool);
  });

  it("detalle completo: valida con el contrato y trae correcciones, reportes, orden activa, ítems y eventos", async () => {
    const f = await fixture();
    const { territoryId: t, body } = await getIncidentDetail(f.pool, f.incidentId);
    expect(t).toBe(f.mvd);
    expect(() => IncidentDetailResponse.parse(body)).not.toThrow();

    expect(body.incident).toMatchObject({ id: f.incidentId, revision: await revisionOf(f.pool, f.incidentId), severity: "high", priorityBand: "high", bandOverride: null, reportCount: 2 });
    expect(body.incident.priorityRules).toContain("severity_high");
    expect(body.overrides).toEqual([expect.objectContaining({ field: "severity", value: "high", reason: "riesgo visto en el lugar" })]);

    expect(body.reports.map((r) => r.linkOrigin).sort()).toEqual(["auto", "manual"]);
    const auto = body.reports.find((r) => r.id === f.autoReport)!;
    expect(auto.photoIds).toEqual([f.photoId]);
    expect(auto.description).toBe("Hay un pozo grande en la calle");
    expect(auto.messages).toContainEqual(expect.objectContaining({ role: "citizen", body: "Hay un pozo grande en la calle" }));
    expect(body.reports.find((r) => r.id === f.manualReport)!.photoIds).toEqual([]);

    expect(body.activeAssignment).toMatchObject({ id: f.assignmentId, status: "offered", version: 1, reviewBlocked: false });
    expect(body.activeAssignment!.unitName).toBeTruthy();
    expect(body.openReviewItems).toEqual([expect.objectContaining({ kind: "contradiction", reasons: [{ code: "reports_inconsistent" }] })]);

    const kinds = body.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["override_set", "report_linked", "linked", "offered"])); // incidente, reporte y orden
    const times = body.events.map((e) => e.createdAt);
    expect([...times].sort().reverse()).toEqual(times); // del más nuevo al más viejo
    expect(body.problemTypes.map((p) => p.slug)).toContain("bache");
  });

  it("la banda corregida por el operador se informa como bandOverride", async () => {
    const f = await fixture();
    await withTx(async (c) => setOverride(c, { incidentId: f.incidentId, override: { field: "priority_band", value: "low" }, reason: "no es urgente", actor: { type: "operator", id: f.operatorId }, expectedRevision: await revisionOf(f.pool, f.incidentId) }), f.pool);
    const { body } = await getIncidentDetail(f.pool, f.incidentId);
    expect(body.incident).toMatchObject({ priorityBand: "low", bandOverride: "low" });
  });

  it("id que no es uuid o inexistente ⇒ 404", async () => {
    const pool = await testDb();
    await expect(getIncidentDetail(pool, "no-es-un-uuid")).rejects.toMatchObject({ status: 404 });
    await expect(getIncidentDetail(pool, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 404 });
  });

  it("fotos: un adjunto de Montevideo pedido desde demo-b ⇒ 404; desde Montevideo devuelve el derivado", async () => {
    const f = await fixture();
    const storage = memoryStorage();
    await storage.put("k-jev", Buffer.from("jpg"), "image/jpeg");
    await expect(getOperatorPhoto(f.pool, storage, { territoryId: f.b, attachmentId: f.photoId, size: "full" })).rejects.toMatchObject({ status: 404 });
    expect((await getOperatorPhoto(f.pool, storage, { territoryId: f.mvd, attachmentId: f.photoId, size: "full" })).toString()).toBe("jpg");
    await expect(getOperatorPhoto(f.pool, storage, { territoryId: f.mvd, attachmentId: "x", size: "full" })).rejects.toMatchObject({ status: 404 });
  });

  it("corrección con la revisión vieja ⇒ 409 revision_conflict y no se aplica", async () => {
    const f = await fixture();
    const seen = await revisionOf(f.pool, f.incidentId);
    await f.pool.query("update incidents set revision = revision + 1 where id = $1", [f.incidentId]); // otro proceso subió la revisión
    const body = { override: { field: "severity" as const, value: "low" as const }, reason: "era chico", expectedRevision: seen, idempotencyKey: "ovr-00000001" };
    await expect(withTx((c) => requestSetOverride(c, { incidentId: f.incidentId, userId: f.operatorId, body }), f.pool)).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    expect((await one(f.pool, "select severity from incidents where id = $1", [f.incidentId])).severity).toBe("high");
  });

  it("misma idempotencyKey dos veces ⇒ una sola corrección y una sola subida de revisión; con otro pedido ⇒ 409", async () => {
    const f = await fixture();
    const before = await revisionOf(f.pool, f.incidentId);
    const body = { override: { field: "severity" as const, value: "low" as const }, reason: "era chico", expectedRevision: before, idempotencyKey: "ovr-00000002" };
    const run = () => withTx((c) => requestSetOverride(c, { incidentId: f.incidentId, userId: f.operatorId, body }), f.pool);
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.revision).toBe(b.revision);
    expect(await revisionOf(f.pool, f.incidentId)).toBe(before + 1);
    const rows = await f.pool.query("select 1 from incident_overrides where incident_id = $1 and field = 'severity' and value = '\"low\"'", [f.incidentId]);
    expect(rows.rowCount).toBe(1);

    const other = { ...body, override: { field: "severity" as const, value: "medium" as const }, expectedRevision: a.revision };
    await expect(withTx((c) => requestSetOverride(c, { incidentId: f.incidentId, userId: f.operatorId, body: other }), f.pool)).rejects.toMatchObject({ status: 409, code: "idempotency_key_reused" });
  });

  it("quitar una corrección y reintentarlo con la misma clave devuelve lo mismo", async () => {
    const f = await fixture();
    const run = () => withTx((c) => requestRemoveOverride(c, { incidentId: f.incidentId, userId: f.operatorId, field: "severity", idempotencyKey: "rm-000000001" }), f.pool);
    const first = await run();
    const again = await run();
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ ...first, replayed: true });
    await expect(withTx((c) => requestRemoveOverride(c, { incidentId: f.incidentId, userId: f.operatorId, field: "nope", idempotencyKey: "rm-000000002" }), f.pool)).rejects.toMatchObject({ status: 400 });
  });

  it("desasociar: solo un reporte vinculado a este incidente; queda en revisión y el incidente sigue con el otro", async () => {
    const f = await fixture();
    const other = await confirmedReport(f.pool, f.mvd, "Otro reporte suelto");
    const unlink = (reportId: string, key: string) =>
      withTx((c) => requestLink(c, { incidentId: f.incidentId, userId: f.operatorId, body: { action: "unlink", reportId, reason: "es otro pozo", idempotencyKey: key } }), f.pool);
    await expect(unlink(other, "unl-0000001")).rejects.toMatchObject({ status: 404 });
    const r = await unlink(f.manualReport, "unl-0000002");
    expect(r).toMatchObject({ action: "unlink", archived: false, replayed: false });
    expect((await unlink(f.manualReport, "unl-0000002")).replayed).toBe(true);
    expect((await one(f.pool, "select grouping from reports where id = $1", [f.manualReport])).grouping).toBe("review");
    const { body } = await getIncidentDetail(f.pool, f.incidentId);
    expect(body.reports.map((x) => x.id)).toEqual([f.autoReport]);
  });

  describe("rutas", () => {
    it("GET detalle: sin sesión 401; operador de demo-b ⇒ 404 (como inexistente); de Montevideo ⇒ 200 con el contrato", async () => {
      const f = await fixture();
      const url = `http://x/api/operacion/incidents/${f.incidentId}`;
      expect((await getDetailRoute(new Request(url) as never, ctx({ id: f.incidentId }))).status).toBe(401);

      h.session = session(f, f.b);
      const foreign = await getDetailRoute(new Request(url) as never, ctx({ id: f.incidentId }));
      const missing = await getDetailRoute(new Request(url) as never, ctx({ id: "00000000-0000-4000-8000-000000000000" }));
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json()); // misma respuesta: no revela que existe
      expect((await getDetailRoute(new Request(url) as never, ctx({ id: "nope" }))).status).toBe(404);

      h.session = session(f);
      const ok = await getDetailRoute(new Request(url) as never, ctx({ id: f.incidentId }));
      expect(ok.status).toBe(200);
      expect(IncidentDetailResponse.parse(await ok.json()).incident.id).toBe(f.incidentId);
    });

    it("POST overrides: revisión vieja ⇒ 409 revision_conflict; vigente ⇒ revisión + 1; de otro territorio ⇒ 404", async () => {
      const f = await fixture();
      const url = `http://x/api/operacion/incidents/${f.incidentId}/overrides`;
      const rev = await revisionOf(f.pool, f.incidentId);
      const body = (expectedRevision: number, key: string) => ({ override: { field: "severity", value: "medium" }, reason: "revisado", expectedRevision, idempotencyKey: key });

      h.session = session(f, f.b);
      expect((await postOverrideRoute(json(url, "POST", body(rev, "route-0001")), ctx({ id: f.incidentId }))).status).toBe(404);

      h.session = session(f);
      const stale = await postOverrideRoute(json(url, "POST", body(rev - 1, "route-0002")), ctx({ id: f.incidentId }));
      expect(stale.status).toBe(409);
      expect((await stale.json()).error).toBe("revision_conflict");

      const ok = await postOverrideRoute(json(url, "POST", body(rev, "route-0003")), ctx({ id: f.incidentId }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ incidentId: f.incidentId, revision: rev + 1, replayed: false });
    });

    it("DELETE overrides/[field]: campo inválido ⇒ 400; vigente ⇒ 200 y vuelve lo evaluado", async () => {
      const f = await fixture();
      h.session = session(f);
      const url = (field: string) => `http://x/api/operacion/incidents/${f.incidentId}/overrides/${field}`;
      expect((await deleteOverrideRoute(json(url("nope"), "DELETE", { idempotencyKey: "del-0000001" }), ctx({ id: f.incidentId, field: "nope" }))).status).toBe(400);
      const ok = await deleteOverrideRoute(json(url("severity"), "DELETE", { idempotencyKey: "del-0000002" }), ctx({ id: f.incidentId, field: "severity" }));
      expect(ok.status).toBe(200);
      expect((await one(f.pool, "select severity from incidents where id = $1", [f.incidentId])).severity).toBe("medium");
    });

    it("POST links: desasociar un reporte de este incidente ⇒ 200; de otro territorio ⇒ 404", async () => {
      const f = await fixture();
      const url = `http://x/api/operacion/incidents/${f.incidentId}/links`;
      const body = { action: "unlink", reportId: f.manualReport, reason: "es otro pozo", idempotencyKey: "lnk-0000001" };
      h.session = session(f, f.b);
      expect((await postLinkRoute(json(url, "POST", body), ctx({ id: f.incidentId }))).status).toBe(404);
      h.session = session(f);
      const ok = await postLinkRoute(json(url, "POST", body), ctx({ id: f.incidentId }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ action: "unlink", incidentId: f.incidentId, reportId: f.manualReport, archived: false });
    });
  });
});
