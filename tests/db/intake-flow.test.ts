import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { withTx } from "@/server/db/tx";
import { appendCitizenMessage, createDraft, getOwnedReport, getReport, setLocation } from "@/server/intake/drafts";
import { confirmReport } from "@/server/intake/confirm";
import { runIntakeTurn } from "@/server/intake/orchestrator";
import { getDraftView } from "@/server/intake/view";
import { claimNext, enqueue } from "@/server/jobs/queue";
import { runOnce } from "@/server/jobs/worker-loop";
import { handlers } from "@/server/jobs/handlers";
import { DomainError } from "@/server/errors";
import { fakeAnswers, fakeJev, newSession, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

const PLAZA_INDEPENDENCIA = { lon: -56.1993, lat: -34.9068 };

async function draftWithText(text = "Hay un pozo grande en la calle") {
  const pool = await testDb();
  const t = await territoryId(pool);
  const s = await newSession(pool);
  const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
  await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: text }), pool);
  return { pool, t, s, id };
}

describe("recepción → confirmación → job → incidente", () => {
  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
  });

  it("mensaje duplicado por clientMessageId no sube la revisión", async () => {
    const { pool, s, id } = await draftWithText();
    const again = await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: "otra vez" }), pool);
    expect(again.duplicate).toBe(true);
    expect((await getReport(pool, id)).revision).toBe(2);
  });

  it("un id con forma de UUID inválida da 404, no un error de la base", async () => {
    const { pool, s } = await draftWithText();
    await expect(getOwnedReport(pool, "-".repeat(36), s)).rejects.toMatchObject({ status: 404 });
    await expect(getOwnedReport(pool, "cecfb3b355f4-47a9-90c4-9f4e932413c5-", s)).rejects.toMatchObject({ status: 404 });
  });

  it("otra sesión no puede escribir en el borrador", async () => {
    const { pool, id } = await draftWithText();
    const other = await newSession(pool);
    await expect(
      withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: other, clientMessageId: "msg-x0000001", body: "hola" }), pool),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("el turno evalúa con Jev, guarda la evaluación y pide ubicación", async () => {
    const { pool, s, id } = await draftWithText();
    const jev = fakeJev();
    await runIntakeTurn(testDeps(pool, jev), id);
    expect(jev.calls).toHaveLength(1);
    const view = await getDraftView(pool, id, s);
    expect(view.messages.at(-1)?.ui).toEqual({ kind: "ask_location" });
    expect(view.card.typeName).toBe("Bache");
    expect(view.card.ready).toBe(false);
  });

  it("confirmar sin ubicación falla con error tipado location_required", async () => {
    const { pool, s, id } = await draftWithText();
    const err = await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("location_required");
  });

  it("dos confirmaciones devuelven el mismo código y un solo job (foco de revisión 1)", async () => {
    const { pool, s, id } = await draftWithText();
    await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...PLAZA_INDEPENDENCIA, source: "map" }), pool);
    const [a, b] = await Promise.all([
      withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool),
      withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool),
    ]);
    expect(a.publicCode).toBe(b.publicCode);
    expect(a.jobId).toBe(b.jobId);
    const jobs = await pool.query("select count(*)::int as n from jobs where kind = 'process_report' and entity_id = $1", [id]);
    expect(jobs.rows[0].n).toBe(1);
  });

  it("el worker procesa el reporte confirmado, reutiliza la evaluación y crea un incidente localizado", async () => {
    const { pool, s, id } = await draftWithText();
    const jev = fakeJev();
    const deps = testDeps(pool, jev);
    await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...PLAZA_INDEPENDENCIA, source: "map" }), pool);
    await runIntakeTurn(deps, id);
    await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
    expect(await runOnce(deps, handlers, { workerId: "test" })).toBe(true);
    expect(jev.calls).toHaveLength(1); // la evaluación de la recepción se reutilizó

    const inc = await pool.query(
      `select i.priority_band, i.severity, a.name as area, l.active
       from incidents i join report_incident_links l on l.incident_id = i.id left join areas a on a.id = i.area_id where l.report_id = $1`,
      [id],
    );
    expect(inc.rows).toHaveLength(1);
    expect(inc.rows[0]).toMatchObject({ area: "CIUDAD VIEJA", severity: "medium", priority_band: "medium", active: true });
    const r = await getReport(pool, id);
    expect(r).toMatchObject({ processing: "done", outcome: "applicable" });
    const view = await getDraftView(pool, id, s);
    expect(view.tracking?.statusLabel).toBe("registrado, esperando asignación");
  });

  it("fuego activo ⇒ prioridad alta aunque la severidad sea baja", async () => {
    const { pool, s, id } = await draftWithText("se prende fuego el contenedor");
    const deps = testDeps(pool, fakeJev(() => fakeAnswers({ problem_type: { type: "choice", choice: "contenedor_fuego", confidence: 1, probabilities: { contenedor_fuego: 1 } }, severity: { type: "choice", choice: "low", confidence: 1, probabilities: { low: 1 } }, active_fire: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1 } } })));
    await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...PLAZA_INDEPENDENCIA, source: "map" }), pool);
    await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
    await runOnce(deps, handlers, { workerId: "test" });
    const inc = await pool.query("select priority_band, active_hazard, priority_breakdown from incidents");
    expect(inc.rows[0]).toMatchObject({ priority_band: "high", active_hazard: true });
    expect(inc.rows[0].priority_breakdown.rules).toContain("active_hazard");
  });

  it("aplicabilidad insuficiente ⇒ sin incidente y con ítem de revisión", async () => {
    const { pool, s, id } = await draftWithText("hay algo raro");
    const deps = testDeps(pool, fakeJev(() => fakeAnswers({ applicability: { type: "choice", choice: "insufficient", confidence: 1, probabilities: { insufficient: 1 } } })));
    await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...PLAZA_INDEPENDENCIA, source: "map" }), pool);
    await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
    await runOnce(deps, handlers, { workerId: "test" });
    expect((await pool.query("select count(*)::int as n from incidents")).rows[0].n).toBe(0);
    const ri = await pool.query("select kind, entity_type from review_items where status = 'open'");
    expect(ri.rows).toEqual([{ kind: "insufficient_evidence", entity_type: "report" }]);
    expect((await getReport(pool, id)).outcome).toBe("insufficient");
  });

  it("job de evaluación sobre una revisión vieja no responde ni guarda (evaluación obsoleta)", async () => {
    const { pool, s, id } = await draftWithText();
    await enqueue(pool, { kind: "evaluate_report", entityType: "report", entityId: id, entityRevision: 2 });
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "está en la esquina" }), pool);
    const jev = fakeJev();
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
    expect(jev.calls).toHaveLength(0);
    expect((await pool.query("select count(*)::int as n from report_evaluations")).rows[0].n).toBe(0);
  });

  it("dos workers no toman el mismo job; un job fallido agotado abre revisión", async () => {
    const { pool, s, id } = await draftWithText();
    await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...PLAZA_INDEPENDENCIA, source: "map" }), pool);
    await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
    const [a, b] = await Promise.all([claimNext(pool, "w1", 60), claimNext(pool, "w2", 60)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await pool.query("update jobs set status = 'pending', attempts = 2, run_after = now() - interval '1 second'");

    const broken = testDeps(pool, { systemOne: async () => { throw new Error("proveedor caído"); } });
    await runOnce(broken, handlers, { workerId: "w1" });
    const job = await pool.query("select status, attempts from jobs");
    expect(job.rows[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect((await getReport(pool, id)).processing).toBe("error");
    const ri = await pool.query("select kind from review_items where status = 'open'");
    expect(ri.rows.map((r) => r.kind)).toEqual(["provider_failure"]);
  });
});
