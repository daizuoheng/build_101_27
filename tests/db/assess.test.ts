// Reevaluación del incidente (T10). Jev simulado en tests (dobles marcados en fakes.ts); la integración real va por smoke.
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { seedAll } from "../../seeds";
import { policies } from "../../seeds/policies";
import { withTx } from "@/server/db/tx";
import type { JevCall } from "@/server/ai/jev/client";
import { EvaluationPolicy } from "@/server/config/policies";
import { appendCitizenMessage, createDraft, setLocation } from "@/server/intake/drafts";
import { confirmReport } from "@/server/intake/confirm";
import { runOnce } from "@/server/jobs/worker-loop";
import { handlers } from "@/server/jobs/handlers";
import { linkReport } from "@/server/incidents/links";
import { applyOverrides, mergeAssessment, removeOverride, setOverride, type Assessed } from "@/server/incidents/overrides";
import type { IncidentAssessmentResult } from "@/server/ai/jev/assess-incident";
import { DomainError } from "@/server/errors";
import { fakeAnswers, fakeJev, newSession, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

const P = { lon: -56.1993, lat: -34.9068 };
const ch = (choice: string, p = 0.95) => ({ type: "choice" as const, choice, confidence: 0.9, probabilities: { [choice]: p } });
const isAssess = (call: JevCall) => "evolution" in call.questions;
const operator = { type: "operator" as const, id: "00000000-0000-4000-8000-0000000000aa" };

/** Jev simulado: evaluación de reportes fija; la reevaluación responde `assess` (con overrides por campo). */
function jevAssess(assess: Record<string, unknown> = {}, onAssess?: () => Promise<void>) {
  const jev = fakeJev((call) =>
    isAssess(call)
      ? {
          problem_type: ch("bache"), severity: ch("medium"), active_fire: ch("no"), passage: ch("partial"),
          accessibility: ch("not_affected"), evolution: ch("same"), reports_consistency: ch("consistent"), ...assess,
        }
      : fakeAnswers(),
  );
  const orig = jev.systemOne.bind(jev);
  jev.systemOne = async (call) => {
    if (isAssess(call) && onAssess) await onAssess();
    return orig(call);
  };
  return jev;
}
const assessCalls = (jev: ReturnType<typeof fakeJev>) => jev.calls.filter(isAssess).length;

async function confirmedReport(pool: Pool, t: string, text = "Hay un pozo grande en la calle") {
  const s = await newSession(pool);
  const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
  await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: text }), pool);
  await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...P, source: "map" }), pool);
  await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
  return id;
}

const one = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const drain = async (pool: Pool, jev: ReturnType<typeof fakeJev>) => {
  // Procesa todo lo procesable (los jobs `plan` todavía no tienen handler: se ignoran acá).
  for (let i = 0; i < 10; i++) {
    const next = await one(pool, "select kind from jobs where status = 'pending' and kind <> 'plan' and run_after <= now() order by created_at limit 1");
    if (!next) return;
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
  }
};

/** Incidente con dos reportes de sesiones distintas; deja encolado su `assess_incident`. */
async function incidentWithTwoReports(pool: Pool, t: string, jev: ReturnType<typeof fakeJev>) {
  const r1 = await confirmedReport(pool, t);
  await runOnce(testDeps(pool, jev), handlers, { workerId: "test" }); // crea el incidente (sin candidatos)
  const incidentId = (await one(pool, "select incident_id from report_incident_links where report_id = $1 and active", [r1])).incident_id;
  const r2 = await confirmedReport(pool, t, "Sigue el pozo, ahora más grande y un auto cayó adentro");
  await pool.query("update reports set processing = 'done', outcome = 'applicable' where id = $1", [r2]);
  await pool.query("update jobs set status = 'done' where kind = 'process_report'");
  await withTx((c) => linkReport(c, { reportId: r2, incidentId, origin: "manual", actor: operator }), pool);
  return incidentId;
}

describe("reglas puras de reevaluación", () => {
  const policy = EvaluationPolicy.parse(policies.evaluation).assessment;
  const prev: Assessed = { problemTypeId: "t-bache", severity: "medium", activeHazard: false, passage: "partial", accessibility: "not_affected" };
  const ai = (over: Partial<IncidentAssessmentResult>): IncidentAssessmentResult => ({
    problemType: ch("bache"), problemTypeChoice: "bache", problemTypeId: "t-bache", severity: ch("medium"), activeFire: ch("no"),
    passage: ch("partial"), accessibility: ch("not_affected"), evolution: ch("same"), consistency: ch("consistent"), model: "m", ...over,
  });

  it("un valor de la IA solo reemplaza al vigente con probabilidad suficiente y si no es indeterminado", () => {
    expect(mergeAssessment(prev, ai({ severity: ch("high", 0.95) }), policy).severity).toBe("high");
    expect(mergeAssessment(prev, ai({ severity: ch("high", 0.5) }), policy).severity).toBe("medium");
    expect(mergeAssessment(prev, ai({ severity: ch("undetermined", 0.99) }), policy).severity).toBe("medium");
  });

  it("el peligro activo se enciende con evidencia firme y solo se apaga con evidencia muy firme", () => {
    expect(mergeAssessment(prev, ai({ activeFire: ch("yes", 0.8) }), policy).activeHazard).toBe(true);
    const on = { ...prev, activeHazard: true };
    expect(mergeAssessment(on, ai({ activeFire: ch("no", 0.8) }), policy).activeHazard).toBe(true);
    expect(mergeAssessment(on, ai({ activeFire: ch("undeterminable", 0.99) }), policy).activeHazard).toBe(true);
    expect(mergeAssessment(on, ai({ activeFire: ch("no", 0.95) }), policy).activeHazard).toBe(false);
  });

  it("el override gana y deja la discrepancia; priority_band va aparte", () => {
    const r = applyOverrides({ ...prev, severity: "high" }, [{ field: "severity", value: "low" }, { field: "priority_band", value: "medium" }]);
    expect(r.effective.severity).toBe("low");
    expect(r.bandOverride).toBe("medium");
    expect(r.discrepancies).toEqual([{ field: "severity", assessed: "high", effective: "low", override: true }]);
  });
});

describe("assess_incident", () => {
  let pool: Pool;
  let t: string;
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    t = await territoryId(pool);
  });

  it("reevalúa con la evidencia acumulada: cuenta fuentes, recalcula prioridad, sube la revisión y encola plan", async () => {
    const jev = jevAssess({ severity: ch("high"), evolution: ch("worsened") });
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    const before = await one(pool, "select revision, severity, priority_band from incidents where id = $1", [incidentId]);
    await drain(pool, jev);

    const inc = await one(pool, "select revision, severity, priority_band, priority_breakdown from incidents where id = $1", [incidentId]);
    expect(before).toMatchObject({ severity: "medium", priority_band: "medium" });
    expect(inc).toMatchObject({ severity: "high", priority_band: "high", revision: before.revision + 1 });
    expect(inc.priority_breakdown.rules).toContain("severity_high");

    const a = await one(pool, "select reports_considered, source_counts, changes, evidence_summary from incident_assessments where incident_id = $1", [incidentId]);
    expect(a.reports_considered).toHaveLength(2);
    expect(a.source_counts).toMatchObject({ reports: 2, sources: 2, sources_in_window: 2, repeated_evidence: 0 });
    expect(a.changes).toEqual(expect.arrayContaining([{ field: "severity", from: "medium", to: "high", source: "ai" }]));
    expect(a.evidence_summary.ai.evolution.choice).toBe("worsened");
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan' and entity_id = $1", [t])).n).toBeGreaterThanOrEqual(1);

    // Los reportes viajan con índices locales; los ids solo en input_refs.
    const run = await one(pool, "select input_refs, request from ai_runs where purpose = 'assess'");
    expect(Object.keys(run.input_refs.reports)).toEqual(["r1", "r2"]);
    expect(JSON.stringify(run.request)).not.toContain(incidentId);
  });

  it("el override sobrevive a la reevaluación y registra la discrepancia (foco de revisión 5)", async () => {
    const jev = jevAssess({ severity: ch("high") });
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    await drain(pool, jev);
    expect(assessCalls(jev)).toBe(1);

    const rev = (await one(pool, "select revision from incidents where id = $1", [incidentId])).revision;
    await withTx((c) => setOverride(c, { incidentId, override: { field: "severity", value: "low" }, reason: "visto en el lugar", actor: operator, expectedRevision: rev }), pool);
    await drain(pool, jev);

    const inc = await one(pool, "select severity, priority_band from incidents where id = $1", [incidentId]);
    expect(inc).toEqual({ severity: "low", priority_band: "low" });
    const last = await one(pool, "select changes, evidence_summary from incident_assessments where incident_id = $1 order by incident_revision desc limit 1", [incidentId]);
    expect(last.changes).toEqual(expect.arrayContaining([{ field: "severity", assessed: "high", effective: "low", override: true }]));
    // Solo cambió la corrección: se reutilizó la respuesta de Jev, sin otra llamada.
    expect(assessCalls(jev)).toBe(1);
    expect(last.evidence_summary.reused_ai_run).toBe(true);

    // Un reporte nuevo con Jev diciendo high otra vez: el override sigue mandando.
    const r3 = await confirmedReport(pool, t, "El pozo es enorme, peligroso");
    await pool.query("update reports set processing = 'done' where id = $1", [r3]);
    await pool.query("update jobs set status = 'done' where kind = 'process_report'");
    await withTx((c) => linkReport(c, { reportId: r3, incidentId, origin: "manual", actor: operator }), pool);
    await drain(pool, jev);
    expect(assessCalls(jev)).toBe(2);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("low");

    // Quitar la corrección explícitamente devuelve el valor evaluado.
    await withTx((c) => removeOverride(c, { incidentId, field: "severity", actor: operator }), pool);
    await drain(pool, jev);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("high");
  });

  it("descarta el resultado si el incidente cambió de revisión mientras Jev evaluaba", async () => {
    let bumped = false;
    const jev = jevAssess({ severity: ch("high") }, async () => {
      if (bumped) return;
      bumped = true;
      await pool.query("update incidents set revision = revision + 1"); // p. ej. llegó otra corrección
    });
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    const job = await one(pool, "select id from jobs where kind = 'assess_incident' and status = 'pending'");
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
    expect((await one(pool, "select status from jobs where id = $1", [job.id])).status).toBe("done");
    expect((await one(pool, "select count(*)::int as n from incident_assessments where incident_id = $1", [incidentId])).n).toBe(0);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("medium");
  });

  it("peligro activo nuevo con orden activa ⇒ orden bloqueada para revisión", async () => {
    const jev = jevAssess({ active_fire: ch("yes", 0.95) });
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    const unit = await one(pool, "insert into response_units (territory_id, slug, name, unit_kind, capacity) values ($1, 'u1', 'U1', 'mobile_crew', 1) returning id", [t]);
    const asg = await one(pool, "insert into assignments (incident_id, unit_id, status) values ($1, $2, 'accepted') returning id", [incidentId, unit.id]);
    await drain(pool, jev);
    expect((await one(pool, "select active_hazard, priority_band from incidents where id = $1", [incidentId]))).toEqual({ active_hazard: true, priority_band: "high" });
    expect((await one(pool, "select review_blocked from assignments where id = $1", [asg.id])).review_blocked).toBe(true);
    expect((await one(pool, "select kind, entity_type from review_items where entity_id = $1", [asg.id]))).toEqual({ kind: "incompatible_assignment", entity_type: "assignment" });
  });

  it("reportes que se contradicen ⇒ revisión sobre el incidente", async () => {
    const jev = jevAssess({ reports_consistency: ch("contradiction", 0.8) });
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    await drain(pool, jev);
    expect((await one(pool, "select kind from review_items where entity_type = 'incident' and entity_id = $1 and status = 'open'", [incidentId])).kind).toBe("contradiction");
    expect((await one(pool, "select dispatch_blocked from incidents where id = $1", [incidentId])).dispatch_blocked).toBe(true);
  });

  it("las correcciones exigen operador identificado y la revisión vigente", async () => {
    const jev = jevAssess();
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    const rev = (await one(pool, "select revision from incidents where id = $1", [incidentId])).revision;
    const stale = await withTx((c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "x y z", actor: operator, expectedRevision: rev - 1 }), pool).catch((e) => e);
    expect(stale).toBeInstanceOf(DomainError);
    expect(stale.status).toBe(409);
    const anon = await withTx((c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "x y z", actor: { type: "system", id: null }, expectedRevision: rev }), pool).catch((e) => e);
    expect(anon.code).toBe("operator_required");
  });

  it("resolver a mano completa la orden activa en la misma transacción y replanifica", async () => {
    const jev = jevAssess();
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    const unit = await one(pool, "insert into response_units (territory_id, slug, name, unit_kind, capacity) values ($1, 'u1', 'U1', 'mobile_crew', 1) returning id", [t]);
    await one(pool, "insert into assignments (incident_id, unit_id, status) values ($1, $2, 'in_progress') returning id", [incidentId, unit.id]);
    const rev = (await one(pool, "select revision from incidents where id = $1", [incidentId])).revision;
    await withTx((c) => setOverride(c, { incidentId, override: { field: "status", value: "resolved" }, reason: "reparado por la cuadrilla", actor: operator, expectedRevision: rev }), pool);
    expect((await one(pool, "select status, resolved_at is not null as r from incidents where id = $1", [incidentId]))).toEqual({ status: "resolved", r: true });
    expect((await one(pool, "select status, closed_reason from assignments"))).toEqual({ status: "completed", closed_reason: "resolved_by_operator" });
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan' and dedupe_key like '%closed:%'")).n).toBe(1);
    // Un incidente cerrado no se reevalúa.
    await drain(pool, jev);
    expect((await one(pool, "select status from incidents where id = $1", [incidentId])).status).toBe("resolved");
  });
});
