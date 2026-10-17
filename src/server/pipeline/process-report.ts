import { withTx } from "../db/tx";
import { getActivePolicy } from "../config/policies";
import { appendEvent } from "../events/append";
import { locatePoint } from "../geo/locate";
import { getReport } from "../intake/drafts";
import { evaluateRevision, type IntakeDeps } from "../intake/orchestrator";
import { indicatesActiveHazard } from "../intake/branches";
import type { Job } from "../jobs/queue";
import { openReviewItem, type ReviewKind } from "../review/items";
import { computePriority } from "./priority";

/**
 * Pipeline de un reporte confirmado: evaluación vigente → localización → resultado → incidente.
 * La IA se llama fuera de la transacción; la escritura se serializa por territorio.
 * (Agrupación con candidatos: Tarea 9. Por ahora cada reporte aplicable crea su incidente.)
 */
export async function processReport(deps: IntakeDeps, job: Job): Promise<void> {
  const pool = deps.pool;
  const r0 = await getReport(pool, job.entity_id);
  if (r0.status !== "confirmed" || r0.confirmed_revision !== job.entity_revision || r0.processing === "done") return;
  await pool.query("update reports set processing = 'running', updated_at = now() where id = $1 and processing <> 'done'", [r0.id]);

  const res = await evaluateRevision(deps, r0.id, r0.confirmed_revision, { requireCurrentConfig: true });
  if (!res.ok) throw new Error(`evaluación fallida (${res.error.kind}): ${res.error.message}`);
  const ev = res.value;

  await withTx(async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [r0.territory_id]);
    const r = await getReport(c, r0.id, { forUpdate: true });
    if (r.processing === "done") return;
    const finish = async (outcome: string, data: Record<string, unknown> = {}) => {
      await c.query("update reports set processing = 'done', outcome = $2, updated_at = now() where id = $1", [r.id, outcome]);
      await appendEvent(c, { entityType: "report", entityId: r.id, kind: "processed", actorType: "system", data: { outcome, evaluation_id: ev.id, ...data } });
    };

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
    await c.query("insert into report_incident_links (report_id, incident_id, origin) values ($1, $2, 'auto')", [r.id, incidentId]);
    await c.query("update reports set grouping = 'linked' where id = $1", [r.id]);
    await appendEvent(c, { entityType: "incident", entityId: incidentId, kind: "created", actorType: "system", data: { report_id: r.id, evaluation_id: ev.id, priority: priority.band } });

    for (const reason of ev.reviewReasons) {
      const kind: ReviewKind = reason === "insufficient_evidence" ? "insufficient_evidence" : reason;
      await openReviewItem(c, {
        territoryId: r.territory_id, kind, entityType: "incident", entityId: incidentId,
        reasons: [{ code: reason, evaluation_id: ev.id }], evidenceRefs: [{ report_id: r.id, ai_run_id: ev.aiRunId }],
      });
    }
    await finish("applicable", { incident_id: incidentId });
  }, pool);
}

/** Al agotar reintentos: el reporte queda persistido, marcado con error y en la cola de revisión. */
export async function onProcessReportFailed(deps: IntakeDeps, job: Job, error: string): Promise<void> {
  await withTx(async (c) => {
    await c.query("update reports set processing = 'error', updated_at = now() where id = $1 and processing <> 'done'", [job.entity_id]);
    await openReviewItem(c, { territoryId: job.territory_id, kind: "provider_failure", entityType: "report", entityId: job.entity_id, reasons: [{ code: "provider_failure", error: error.slice(0, 500) }] });
  }, deps.pool);
}
