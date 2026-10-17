import type { Db } from "../db/pool";
import { withTx } from "../db/tx";
import { getActivePolicy } from "../config/policies";
import { appendEvent } from "../events/append";
import { locatePoint } from "../geo/locate";
import { insertLink } from "../incidents/links";
import { getReport, type ReportRow } from "../intake/drafts";
import { evaluateRevision, type IntakeDeps } from "../intake/orchestrator";
import type { StoredEvaluation } from "../intake/evaluations";
import { indicatesActiveHazard } from "../intake/branches";
import type { Job } from "../jobs/queue";
import { openReviewItem, type ReviewKind } from "../review/items";
import type { GroupingVerdict } from "../ai/jev/compare-candidates";
import { applyGrouping, findCandidates, prepareGrouping, sameCandidates, type GroupingPlan } from "./group";
import { computePriority } from "./priority";

/** Si los candidatos cambian entre la comparación y la escritura, se compara de nuevo; a la última vuelta, revisión. */
const GROUPING_ROUNDS = 2;

const isApplicable = (ev: StoredEvaluation) => ev.intent !== "other" && ev.applicability === "applicable";

/** Agrupación preparada fuera de la transacción, solo si el reporte es aplicable y cae en su territorio. */
async function planGrouping(deps: IntakeDeps, r: ReportRow, ev: StoredEvaluation): Promise<GroupingPlan | null> {
  if (!isApplicable(ev) || r.lon === null || r.lat === null || !r.territory_id) return null;
  const located = await locatePoint(deps.pool, r.lon, r.lat);
  if (!located || located.territoryId !== r.territory_id) return null;
  return prepareGrouping(deps, { ...r, territory_id: r.territory_id, lon: r.lon, lat: r.lat });
}

/**
 * Pipeline de un reporte confirmado: evaluación vigente → localización → resultado → agrupación → incidente.
 * Jev (evaluación y comparación) se llama fuera de la transacción; la escritura se serializa por territorio
 * y revalida bajo el lock que los candidatos comparados sigan siendo los mismos.
 */
export async function processReport(deps: IntakeDeps, job: Job): Promise<void> {
  const pool = deps.pool;
  const r0 = await getReport(pool, job.entity_id);
  if (r0.status !== "confirmed" || r0.confirmed_revision !== job.entity_revision || r0.processing === "done") return;
  await pool.query("update reports set processing = 'running', updated_at = now() where id = $1 and processing <> 'done'", [r0.id]);

  const res = await evaluateRevision(deps, r0.id, r0.confirmed_revision, { requireCurrentConfig: true });
  if (!res.ok) throw new Error(`evaluación fallida (${res.error.kind}): ${res.error.message}`);
  const ev = res.value;

  for (let round = 1; round <= GROUPING_ROUNDS; round++) {
    const plan = await planGrouping(deps, r0, ev);
    const done = await withTx((c) => writeOutcome(c, r0.id, ev, plan, round === GROUPING_ROUNDS), pool);
    if (done) return;
  }
}

/** Escribe el resultado bajo el lock del territorio. Devuelve false si los candidatos cambiaron y conviene comparar de nuevo. */
async function writeOutcome(c: Db, reportId: string, ev: StoredEvaluation, plan: GroupingPlan | null, lastRound: boolean): Promise<boolean> {
  const r0 = await getReport(c, reportId);
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [r0.territory_id]);
  const r = await getReport(c, reportId, { forUpdate: true });
  if (r.processing === "done") return true;
  const finish = async (outcome: string, data: Record<string, unknown> = {}) => {
    await c.query("update reports set processing = 'done', outcome = $2, updated_at = now() where id = $1", [r.id, outcome]);
    await appendEvent(c, { entityType: "report", entityId: r.id, kind: "processed", actorType: "system", data: { outcome, evaluation_id: ev.id, ...data } });
    return true;
  };

  // Reproceso de un reporte que ya tiene vínculo (p. ej. un operador lo asoció a mano mientras estaba en error):
  // la decisión humana se conserva; no se reagrupa.
  const linked = await c.query<{ incident_id: string }>("select incident_id from report_incident_links where report_id = $1 and active", [r.id]);
  if (linked.rows[0]) return finish("applicable", { incident_id: linked.rows[0].incident_id, grouping: "kept_existing_link" });

  const located = r.lon !== null && r.lat !== null ? await locatePoint(c, r.lon, r.lat) : null;
  if (!located || located.territoryId !== r.territory_id) {
    await openReviewItem(c, { territoryId: r.territory_id, kind: "out_of_coverage", entityType: "report", entityId: r.id, reasons: [{ code: "outside_territory" }] });
    return finish("out_of_coverage");
  }
  await c.query("update reports set area_id = $2 where id = $1", [r.id, located.areaId]);

  if (ev.intent === "other" || ev.applicability === "unrelated") return finish("unrelated");
  if (ev.applicability === "insufficient") {
    await openReviewItem(c, {
      territoryId: r.territory_id, kind: "insufficient_evidence", entityType: "report", entityId: r.id,
      reasons: [{ code: "insufficient_evidence", evaluation_id: ev.id }], evidenceRefs: [{ report_id: r.id, ai_run_id: ev.aiRunId }],
    });
    return finish("insufficient");
  }

  // Agrupación: los candidatos comparados fuera de la transacción tienen que seguir siendo los mismos.
  if (!plan) throw new Error("agrupación no preparada para un reporte aplicable");
  const fresh = await findCandidates(c, {
    territoryId: r.territory_id!, lon: r.lon!, lat: r.lat!, radiusM: plan.policy.config.radius_m, limit: plan.policy.config.max_candidates,
  });
  let verdict: GroupingVerdict = plan.comparison?.verdict ?? { kind: "create", reasons: ["no_candidates"] };
  if (!sameCandidates(fresh, plan.found)) {
    if (!lastRound) return false;
    // La comparación de Jev fue sobre otro conjunto: no se guarda como si correspondiera a estos candidatos.
    plan = { ...plan, found: fresh, comparison: null };
    verdict = { kind: "review", reasons: ["candidates_changed"] };
  }
  const evidenceRefs = { report_id: r.id, evaluation_id: ev.id, evaluation_ai_run_id: ev.aiRunId };
  const grouped = await applyGrouping(c, { report: { id: r.id, territoryId: r.territory_id! }, plan, verdict, evidenceRefs });
  const openEvaluationReviews = async (entityType: "incident" | "report", entityId: string) => {
    for (const reason of ev.reviewReasons) {
      const kind: ReviewKind = reason === "insufficient_evidence" ? "insufficient_evidence" : reason;
      await openReviewItem(c, {
        territoryId: r.territory_id, kind, entityType, entityId,
        reasons: [{ code: reason, evaluation_id: ev.id }], evidenceRefs: [{ report_id: r.id, ai_run_id: ev.aiRunId }],
      });
    }
  };
  if (grouped.kind === "link") {
    await openEvaluationReviews("incident", grouped.incidentId!);
    return finish("applicable", { incident_id: grouped.incidentId, grouping: "linked", grouping_decision_id: grouped.decisionId });
  }
  if (grouped.kind === "review") {
    await openEvaluationReviews("report", r.id);
    return finish("applicable", { grouping: "review", grouping_decision_id: grouped.decisionId });
  }

  const priorityPolicy = await getActivePolicy(c, r.territory_id!, "priority");
  const activeHazard = indicatesActiveHazard(ev);
  const now = new Date();
  const priority = computePriority(
    { severity: ev.severity, activeHazard, passage: ev.passage, accessibility: ev.accessibility },
    now, now, priorityPolicy.config,
  );
  const typeName = ev.problemTypeId
    ? (await c.query<{ name: string }>("select name from problem_types where id = $1", [ev.problemTypeId])).rows[0]?.name
    : null;
  const title = [typeName ?? "Problema sin clasificar", located.areaName ? `— ${located.areaName}` : null].filter(Boolean).join(" ");

  const inc = await c.query<{ id: string }>(
    `insert into incidents (territory_id, area_id, problem_type_id, severity, active_hazard, passage, accessibility, location, location_text,
       title, priority_band, priority_breakdown)
     select $1, $2, $3, $4, $5, $6, $7, location, location_text, $8, $9, $10 from reports where id = $11
     returning id`,
    [r.territory_id, located.areaId, ev.problemTypeId, ev.severity, activeHazard, ev.passage, ev.accessibility, title, priority.band, priority.breakdown, r.id],
  );
  const incidentId = inc.rows[0].id;
  await insertLink(c, { reportId: r.id, incidentId, origin: "auto", decisionId: grouped.decisionId });
  await appendEvent(c, { entityType: "incident", entityId: incidentId, kind: "created", actorType: "system", data: { report_id: r.id, evaluation_id: ev.id, priority: priority.band, grouping_decision_id: grouped.decisionId } });
  await openEvaluationReviews("incident", incidentId);
  return finish("applicable", { incident_id: incidentId, grouping: "created", grouping_decision_id: grouped.decisionId });
}

/** Al agotar reintentos: el reporte queda persistido, marcado con error y en la cola de revisión. */
export async function onProcessReportFailed(deps: IntakeDeps, job: Job, error: string): Promise<void> {
  await withTx(async (c) => {
    await c.query("update reports set processing = 'error', updated_at = now() where id = $1 and processing <> 'done'", [job.entity_id]);
    await openReviewItem(c, { territoryId: job.territory_id, kind: "provider_failure", entityType: "report", entityId: job.entity_id, reasons: [{ code: "provider_failure", error: error.slice(0, 500) }] });
  }, deps.pool);
}
