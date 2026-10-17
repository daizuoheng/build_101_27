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

/** Jev simulado: evaluación de reportes fija (bache, severidad media); la reevaluación responde `assess`. */
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
const downJev = () => ({ systemOne: async () => { throw new Error("Jev caído"); } });

async function confirmedReport(pool: Pool, t: string, text = "Hay un pozo grande en la calle") {
  const s = await newSession(pool);
  const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
  await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: text }), pool);
  await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...P, source: "map" }), pool);
  await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
  return id;
}

const one = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const drain = async (pool: Pool, jev: ReturnType<typeof fakeJev> | ReturnType<typeof downJev>) => {
  // Procesa todo lo procesable (los jobs `plan` todavía no tienen handler: se ignoran acá).
  for (let i = 0; i < 10; i++) {
    const next = await one(pool, "select kind from jobs where status = 'pending' and kind <> 'plan' and run_after <= now() order by created_at limit 1");
    if (!next) return;
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
  }
};
const revisionOf = async (pool: Pool, id: string) => (await one(pool, "select revision from incidents where id = $1", [id])).revision as number;

async function singleReportIncident(pool: Pool, t: string, jev: ReturnType<typeof fakeJev>) {
  const r1 = await confirmedReport(pool, t);
  await runOnce(testDeps(pool, jev), handlers, { workerId: "test" }); // crea el incidente (sin candidatos)
  return (await one(pool, "select incident_id from report_incident_links where report_id = $1 and active", [r1])).incident_id as string;
}

/** Suma un reporte de otra sesión al incidente; deja encolado su `assess_incident`. */
async function addReport(pool: Pool, t: string, incidentId: string, text = "Sigue el pozo, ahora más grande y un auto cayó adentro") {
  const r = await confirmedReport(pool, t, text);
  await pool.query("update reports set processing = 'done', outcome = 'applicable' where id = $1", [r]);
  await pool.query("update jobs set status = 'done' where kind = 'process_report'");
  await withTx((c) => linkReport(c, { reportId: r, incidentId, origin: "manual", actor: operator }), pool);
  return r;
}

async function incidentWithTwoReports(pool: Pool, t: string, jev: ReturnType<typeof fakeJev>) {
  const incidentId = await singleReportIncident(pool, t, jev);
  await addReport(pool, t, incidentId);
  return incidentId;
}

async function unitWithAssignment(pool: Pool, t: string, incidentId: string, status: string) {
  const unit = await one(pool, "insert into response_units (territory_id, slug, name, unit_kind, capacity) values ($1, $2, 'U', 'mobile_crew', 1) returning id", [t, `u-${status}`]);
  return (await one(pool, "insert into assignments (incident_id, unit_id, status) values ($1, $2, $3) returning id, version", [incidentId, unit.id, status])) as { id: string; version: number };
}

describe("reglas puras de reevaluación", () => {
  const policy = EvaluationPolicy.parse(policies.evaluation).assessment;
  const prev: Assessed = { problemTypeId: "t-bache", severity: "medium", activeHazard: false, passage: "partial", accessibility: "not_affected" };
  const ai = (over: Partial<IncidentAssessmentResult>): IncidentAssessmentResult => ({
    problemType: ch("bache"), problemTypeChoice: "bache", problemTypeId: "t-bache", severity: ch("medium"), activeFire: ch("no"),
    passage: ch("partial"), accessibility: ch("not_affected"), evolution: ch("same"), consistency: ch("consistent"), model: "m", ...over,
  });

  it("un valor de la IA solo reemplaza al anterior con probabilidad suficiente y si no es indeterminado", () => {
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

describe("assess_incident y correcciones", () => {
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

    const a = await one(pool, "select reports_considered, source_counts, changes, evidence_summary from incident_assessments where incident_id = $1 and ai_run_id is not null order by incident_revision desc limit 1", [incidentId]);
    expect(a.reports_considered).toHaveLength(2);
    expect(a.source_counts).toMatchObject({ reports: 2, sources: 2, sources_in_window: 2, repeated_evidence: 0 });
    expect(a.changes).toEqual(expect.arrayContaining([{ field: "severity", from: "medium", to: "high", source: "ai" }]));
    expect(a.evidence_summary.ai.evolution.choice).toBe("worsened");
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan' and entity_id = $1", [t])).n).toBeGreaterThanOrEqual(1);
    const rev = await revisionOf(pool, incidentId);
    expect((await pool.query("select entity_revision from jobs where kind = 'textgen' and entity_id = $1 order by entity_revision", [incidentId])).rows.map((r) => r.entity_revision)).toContain(rev);

    // Los reportes viajan con índices locales; los ids solo en input_refs.
    const run = await one(pool, "select input_refs, request from ai_runs where purpose = 'assess'");
    expect(Object.keys(run.input_refs.reports)).toEqual(["r1", "r2"]);
    expect(JSON.stringify(run.request)).not.toContain(incidentId);
  });

  it("el override sobrevive a la reevaluación y registra la discrepancia (foco de revisión 5)", async () => {
    const jev = jevAssess({ severity: ch("high") });
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    await drain(pool, jev);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("high");

    const rev = await revisionOf(pool, incidentId);
    await withTx((c) => setOverride(c, { incidentId, override: { field: "severity", value: "low" }, reason: "visto en el lugar", actor: operator, expectedRevision: rev }), pool);
    // Se aplica en el acto, sin otra llamada a Jev.
    expect(await one(pool, "select severity, priority_band from incidents where id = $1", [incidentId])).toEqual({ severity: "low", priority_band: "low" });
    expect(assessCalls(jev)).toBe(1);

    // Un reporte nuevo con Jev diciendo high otra vez: la corrección sigue mandando y la discrepancia queda registrada.
    await addReport(pool, t, incidentId, "El pozo es enorme, peligroso");
    await drain(pool, jev);
    expect(assessCalls(jev)).toBe(2);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("low");
    const last = await one(pool, "select changes from incident_assessments where incident_id = $1 order by incident_revision desc limit 1", [incidentId]);
    expect(last.changes).toEqual(expect.arrayContaining([{ field: "severity", assessed: "high", effective: "low", override: true }]));
  });

  it("quitar la corrección devuelve lo último que evaluó la IA, aunque la IA no esté firme ahora", async () => {
    // La IA evaluó high firme; después llega evidencia con high poco firme (no cambia la base) y quitamos la corrección.
    let p = 0.95;
    const jev = jevAssess({});
    const orig = jev.systemOne.bind(jev);
    jev.systemOne = async (call) => {
      const r = await orig(call);
      if (isAssess(call)) (r.data.answers as Record<string, unknown>).severity = ch("high", p);
      return r;
    };
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    await drain(pool, jev);
    await withTx(async (c) => setOverride(c, { incidentId, override: { field: "severity", value: "low" }, reason: "visto en el lugar", actor: operator, expectedRevision: await revisionOf(c as never, incidentId) }), pool);
    p = 0.6;
    await addReport(pool, t, incidentId, "otro reporte");
    await drain(pool, jev);
    await withTx((c) => removeOverride(c, { incidentId, field: "severity", actor: operator }), pool);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("high");
  });

  it("una corrección no depende de Jev: con Jev caído se aplica igual y no abre provider_failure", async () => {
    const jev = jevAssess();
    const incidentId = await singleReportIncident(pool, t, jev);
    const rev = await revisionOf(pool, incidentId);
    await withTx((c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "riesgo visto en el lugar", actor: operator, expectedRevision: rev }), pool);
    await drain(pool, downJev());
    expect(await one(pool, "select severity, priority_band from incidents where id = $1", [incidentId])).toEqual({ severity: "high", priority_band: "high" });
    expect((await one(pool, "select count(*)::int as n from review_items where kind = 'provider_failure'")).n).toBe(0);
  });

  it("la revisión que devuelve setOverride sigue sirviendo para la próxima corrección", async () => {
    const jev = jevAssess();
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    await drain(pool, jev);
    const first = await withTx(async (c) => setOverride(c, { incidentId, override: { field: "severity", value: "low" }, reason: "primera", actor: operator, expectedRevision: await revisionOf(c as never, incidentId) }), pool);
    await drain(pool, jev);
    const second = await withTx((c) => setOverride(c, { incidentId, override: { field: "priority_band", value: "high" }, reason: "segunda", actor: operator, expectedRevision: first.revision }), pool);
    expect(second.revision).toBe(first.revision + 1);
    expect((await one(pool, "select priority_band from incidents where id = $1", [incidentId])).priority_band).toBe("high");
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
    await pool.query("update jobs set status = 'done' where kind = 'textgen'"); // los textos de la revisión 1 no son lo que se mide
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
    expect((await one(pool, "select status from jobs where id = $1", [job.id])).status).toBe("done");
    expect((await one(pool, "select count(*)::int as n from incident_assessments where incident_id = $1 and ai_run_id is not null and incident_revision > 1", [incidentId])).n).toBe(0);
    // Resultado descartado: no se encolan textos para una revisión que no evaluó.
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'textgen' and entity_id = $1 and entity_revision > 1", [incidentId])).n).toBe(0);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("medium");
  });

  it("peligro activo nuevo con orden activa ⇒ orden bloqueada una sola vez", async () => {
    const jev = jevAssess({ active_fire: ch("yes", 0.95) });
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    const asg = await unitWithAssignment(pool, t, incidentId, "accepted");
    await drain(pool, jev);
    expect(await one(pool, "select active_hazard, priority_band from incidents where id = $1", [incidentId])).toEqual({ active_hazard: true, priority_band: "high" });
    expect(await one(pool, "select review_blocked, version from assignments where id = $1", [asg.id])).toEqual({ review_blocked: true, version: asg.version + 1 });
    expect(await one(pool, "select kind, entity_type from review_items where entity_id = $1", [asg.id])).toEqual({ kind: "incompatible_assignment", entity_type: "assignment" });
  });

  it("corregir el tipo al mismo valor no bloquea la orden; cambiarlo la bloquea una vez", async () => {
    const jev = jevAssess();
    const incidentId = await singleReportIncident(pool, t, jev);
    const asg = await unitWithAssignment(pool, t, incidentId, "accepted");
    const bache = (await one(pool, "select id from problem_types where slug = 'bache'")).id;
    const basura = (await one(pool, "select id from problem_types where slug = 'basura_acumulada'")).id;
    const r1 = await withTx(async (c) => setOverride(c, { incidentId, override: { field: "problem_type_id", value: bache }, reason: "confirmo", actor: operator, expectedRevision: await revisionOf(c as never, incidentId) }), pool);
    expect((await one(pool, "select review_blocked from assignments where id = $1", [asg.id])).review_blocked).toBe(false);
    await withTx((c) => setOverride(c, { incidentId, override: { field: "problem_type_id", value: basura }, reason: "es basura", actor: operator, expectedRevision: r1.revision }), pool);
    expect(await one(pool, "select review_blocked, version from assignments where id = $1", [asg.id])).toEqual({ review_blocked: true, version: asg.version + 1 });
    expect((await one(pool, "select count(*)::int as n from events where entity_id = $1 and kind = 'review_blocked'", [asg.id])).n).toBe(1);
  });

  it("reportes que se contradicen ⇒ revisión sobre el incidente", async () => {
    const jev = jevAssess({ reports_consistency: ch("contradiction", 0.8) });
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    await drain(pool, jev);
    expect((await one(pool, "select kind from review_items where entity_type = 'incident' and entity_id = $1 and status = 'open'", [incidentId])).kind).toBe("contradiction");
    expect((await one(pool, "select dispatch_blocked from incidents where id = $1", [incidentId])).dispatch_blocked).toBe(true);
  });

  it("reports_considered registra solo los reportes que vio Jev", async () => {
    await pool.query(
      "update policy_versions set config = jsonb_set(config, '{assessment,max_reports}', '2') where territory_id = $1 and kind = 'evaluation' and active",
      [t],
    );
    const jev = jevAssess();
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    await pool.query("update jobs set status = 'done' where kind = 'assess_incident'");
    await addReport(pool, t, incidentId, "tercer reporte del mismo pozo");
    await drain(pool, jev);
    const a = await one(pool, "select reports_considered, evidence_summary from incident_assessments where incident_id = $1 order by incident_revision desc limit 1", [incidentId]);
    expect(a.reports_considered).toHaveLength(2);
    expect(a.evidence_summary.all_report_ids).toHaveLength(3);
  });

  it("una falla de reevaluación ya obsoleta no abre provider_failure", async () => {
    const jev = jevAssess();
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    await pool.query("update jobs set attempts = 2 where kind = 'assess_incident'");
    await pool.query("update incidents set revision = revision + 1 where id = $1", [incidentId]); // ya hay otra revisión
    await drain(pool, downJev());
    expect((await one(pool, "select count(*)::int as n from review_items where kind = 'provider_failure'")).n).toBe(0);
  });

  it("una corrección hecha con una reevaluación pendiente no la pierde: se reencola para la revisión nueva", async () => {
    const jev = jevAssess({ severity: ch("high") });
    const incidentId = await incidentWithTwoReports(pool, t, jev); // deja assess_incident pendiente
    const bache = (await one(pool, "select id from problem_types where slug = 'bache'")).id;
    await withTx(async (c) => setOverride(c, { incidentId, override: { field: "problem_type_id", value: bache }, reason: "confirmo tipo", actor: operator, expectedRevision: await revisionOf(c as never, incidentId) }), pool);
    await drain(pool, jev);
    expect(assessCalls(jev)).toBe(1); // la evidencia nueva sí se evaluó
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("high");
  });

  it("sin base guardada, quitar una corrección vuelve a la evaluación del reporte, no a las columnas corregidas", async () => {
    const jev = jevAssess();
    const incidentId = await singleReportIncident(pool, t, jev); // la evaluación del reporte dijo severidad media
    await pool.query("delete from incident_assessments where incident_id = $1", [incidentId]); // incidente creado antes de guardar la base
    await withTx(async (c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "riesgo visto", actor: operator, expectedRevision: await revisionOf(c as never, incidentId) }), pool);
    await withTx((c) => removeOverride(c, { incidentId, field: "severity", actor: operator }), pool);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("medium");

    // Un reporte desasociado no cuenta como base: con su vínculo inactivo, la base sale del siguiente reporte activo.
    const r2 = await addReport(pool, t, incidentId, "otro");
    await pool.query(
      `insert into report_evaluations (report_id, report_revision, ai_run_id, policy_version_id, catalog_hash, intent, applicability, problem_type_id,
         problem_type_choice, severity, active_fire, passage, accessibility, location_in_text, photo_quality, contradiction, answers, needs_review, review_reasons)
       select $1, (select confirmed_revision from reports where id = $1), ai_run_id, policy_version_id, catalog_hash, intent, applicability, problem_type_id,
         problem_type_choice, 'low', active_fire, passage, accessibility, location_in_text, photo_quality, contradiction, answers, needs_review, review_reasons
       from report_evaluations e join report_incident_links l on l.report_id = e.report_id where l.incident_id = $2 and l.report_id <> $1 limit 1`,
      [r2, incidentId],
    );
    await pool.query("update report_incident_links set active = false where incident_id = $1 and report_id <> $2", [incidentId, r2]);
    await pool.query("delete from incident_assessments where incident_id = $1", [incidentId]);
    await withTx(async (c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "riesgo visto", actor: operator, expectedRevision: await revisionOf(c as never, incidentId) }), pool);
    await withTx((c) => removeOverride(c, { incidentId, field: "severity", actor: operator }), pool);
    expect((await one(pool, "select severity from incidents where id = $1", [incidentId])).severity).toBe("low");
  });

  it("no se quitan correcciones de un incidente cerrado", async () => {
    const jev = jevAssess();
    const incidentId = await singleReportIncident(pool, t, jev);
    const r = await withTx(async (c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "riesgo visto", actor: operator, expectedRevision: await revisionOf(c as never, incidentId) }), pool);
    await withTx((c) => setOverride(c, { incidentId, override: { field: "status", value: "resolved" }, reason: "reparado", actor: operator, expectedRevision: r.revision }), pool);
    const before = await one(pool, "select revision, severity from incidents where id = $1", [incidentId]);
    const err = await withTx((c) => removeOverride(c, { incidentId, field: "severity", actor: operator }), pool).catch((e) => e);
    expect(err.code).toBe("incident_closed");
    expect(await one(pool, "select revision, severity from incidents where id = $1", [incidentId])).toEqual(before);
  });

  it("las correcciones exigen operador identificado y la revisión vigente", async () => {
    const jev = jevAssess();
    const incidentId = await incidentWithTwoReports(pool, t, jev);
    const rev = await revisionOf(pool, incidentId);
    const stale = await withTx((c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "x y z", actor: operator, expectedRevision: rev - 1 }), pool).catch((e) => e);
    expect(stale).toBeInstanceOf(DomainError);
    expect(stale.status).toBe(409);
    const anon = await withTx((c) => setOverride(c, { incidentId, override: { field: "severity", value: "high" }, reason: "x y z", actor: { type: "system", id: null }, expectedRevision: rev }), pool).catch((e) => e);
    expect(anon.code).toBe("operator_required");
  });

  it("resolver a mano completa la orden en curso, cancela la ofrecida y cierra sus revisiones", async () => {
    const jev = jevAssess();
    const a = await singleReportIncident(pool, t, jev);
    const inProgress = await unitWithAssignment(pool, t, a, "in_progress");
    await withTx(async (c) => setOverride(c, { incidentId: a, override: { field: "status", value: "resolved" }, reason: "reparado por la cuadrilla", actor: operator, expectedRevision: await revisionOf(c as never, a) }), pool);
    expect(await one(pool, "select status, resolved_at is not null as r from incidents where id = $1", [a])).toEqual({ status: "resolved", r: true });
    expect(await one(pool, "select status, closed_reason from assignments where id = $1", [inProgress.id])).toEqual({ status: "completed", closed_reason: "resolved_by_operator" });

    await pool.query("delete from report_incident_links; delete from incident_assessments; delete from jobs");
    const b = await singleReportIncident(pool, t, jev);
    const offered = await unitWithAssignment(pool, t, b, "offered");
    const item = await one(pool, "insert into review_items (territory_id, kind, entity_type, entity_id) values ($1, 'incompatible_assignment', 'assignment', $2) returning id", [t, offered.id]);
    await withTx(async (c) => setOverride(c, { incidentId: b, override: { field: "status", value: "resolved" }, reason: "ya estaba arreglado", actor: operator, expectedRevision: await revisionOf(c as never, b) }), pool);
    expect(await one(pool, "select status, closed_reason from assignments where id = $1", [offered.id])).toEqual({ status: "cancelled", closed_reason: "incident_closed_by_operator" });
    expect((await one(pool, "select status from review_items where id = $1", [item.id])).status).toBe("dismissed");
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan' and dedupe_key like '%closed:%'")).n).toBe(1);
  });
});
