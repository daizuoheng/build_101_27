import type { Db } from "../db/pool";
import { withTx } from "../db/tx";
import { appendEvent } from "../events/append";
import { locatePoint } from "../geo/locate";
import { getReport, type ReportRow } from "../intake/drafts";
import { evaluateRevision, type IntakeDeps } from "../intake/orchestrator";
import type { StoredEvaluation } from "../intake/evaluations";
import { enqueue, type Job } from "../jobs/queue";
import { openReviewItem, type ReviewKind } from "../review/items";
import type { GroupingVerdict } from "../ai/jev/compare-candidates";
import { createIncidentFromReport } from "./create-incident";
import { applyGrouping, findCandidates, prepareGrouping, sameCandidates, type GroupingPlan } from "./group";

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
    // Un incidente nuevo o una fuente nueva (también al reprocesar un vínculo existente): plan del territorio en el acto,
    // sin esperar al periódico. Un pedido por reporte; `planHandler` junta los pendientes en una sola corrida.
    // El territorio sale del incidente: es el que se planifica, aunque el reporte no tenga territorio propio.
    if (typeof data.incident_id === "string") {
      const territoryId = (await c.query<{ territory_id: string }>("select territory_id from incidents where id = $1", [data.incident_id])).rows[0].territory_id;
      await enqueue(c, {
        kind: "plan", entityType: "territory", entityId: territoryId, entityRevision: 0, territoryId,
        payload: { trigger: "report" }, dedupeSuffix: `report:${r.id}`,
      });
    }
    return true;
  };

  const openEvaluationReviews = async (entityType: "incident" | "report", entityId: string) => {
    for (const reason of ev.reviewReasons) {
      const kind: ReviewKind = reason === "insufficient_evidence" ? "insufficient_evidence" : reason;
      await openReviewItem(c, {
        territoryId: r.territory_id, kind, entityType, entityId,
        reasons: [{ code: reason, evaluation_id: ev.id }], evidenceRefs: [{ report_id: r.id, ai_run_id: ev.aiRunId }],
      });
    }
  };

  // Reproceso de un reporte que ya tiene vínculo (p. ej. un operador lo asoció a mano mientras estaba en error):
  // la decisión humana se conserva y no se reagrupa, pero la evaluación nueva igual pasa por la revisión.
  const linked = await c.query<{ incident_id: string }>("select incident_id from report_incident_links where report_id = $1 and active", [r.id]);
  if (linked.rows[0]) {
    const incidentId = linked.rows[0].incident_id;
    await openEvaluationReviews("incident", incidentId);
    if (!isApplicable(ev)) {
      // La IA no ve un problema aplicable donde el operador sí: se deja la discrepancia a la vista y se frena el despacho.
      await openReviewItem(c, {
        territoryId: r.territory_id, kind: "insufficient_evidence", entityType: "incident", entityId: incidentId,
        reasons: [{ code: "evaluation_disagrees_with_manual_link", intent: ev.intent, applicability: ev.applicability, evaluation_id: ev.id }],
        evidenceRefs: [{ report_id: r.id, ai_run_id: ev.aiRunId }],
      });
    }
    return finish("applicable", { incident_id: incidentId, grouping: "kept_existing_link" });
  }

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
  if (grouped.kind === "link") {
    await openEvaluationReviews("incident", grouped.incidentId!);
    return finish("applicable", { incident_id: grouped.incidentId, grouping: "linked", grouping_decision_id: grouped.decisionId });
  }
  if (grouped.kind === "review") {
    await openEvaluationReviews("report", r.id);
    return finish("applicable", { grouping: "review", grouping_decision_id: grouped.decisionId });
  }

  const { incidentId, priorityBand } = await createIncidentFromReport(c, {
    reportId: r.id, evaluation: ev, areaId: located.areaId, areaName: located.areaName, groupingDecisionId: grouped.decisionId, origin: "auto",
  });
  await appendEvent(c, { entityType: "incident", entityId: incidentId, kind: "created", actorType: "system", data: { report_id: r.id, evaluation_id: ev.id, priority: priorityBand, grouping_decision_id: grouped.decisionId } });
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
