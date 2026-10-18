import type { Db } from "../db/pool";
import { getActivePolicy } from "../config/policies";
import { insertLink } from "../incidents/links";
import type { StoredEvaluation } from "../intake/evaluations";
import { indicatesActiveHazard } from "../intake/branches";
import { computePriority } from "./priority";
import { enqueueTextgen } from "./textgen";

/**
 * Incidente nuevo a partir de un reporte y su evaluación: prioridad, título, vínculo, textos de la revisión 1 y la
 * evaluación base de la IA. Lo usan el pipeline (`origin: "auto"`) y la cola de revisión (`create_incident`, `"manual"`).
 * Corre dentro de la transacción del llamador, que ya tiene el lock del territorio; eventos y plan los pone el llamador.
 */
export async function createIncidentFromReport(
  c: Db,
  input: { reportId: string; evaluation: StoredEvaluation; areaId: string | null; areaName: string | null; groupingDecisionId: string | null; origin: "auto" | "manual" },
): Promise<{ incidentId: string; priorityBand: string }> {
  const { reportId, evaluation: ev, areaId, areaName, groupingDecisionId, origin } = input;
  const territoryId = (await c.query<{ territory_id: string }>("select territory_id from reports where id = $1", [reportId])).rows[0].territory_id;
  const priorityPolicy = await getActivePolicy(c, territoryId, "priority");
  const activeHazard = indicatesActiveHazard(ev);
  const now = new Date();
  const priority = computePriority(
    { severity: ev.severity, activeHazard, passage: ev.passage, accessibility: ev.accessibility },
    now, now, priorityPolicy.config,
  );
  const typeName = ev.problemTypeId
    ? (await c.query<{ name: string }>("select name from problem_types where id = $1", [ev.problemTypeId])).rows[0]?.name
    : null;
  const title = [typeName ?? "Problema sin clasificar", areaName ? `— ${areaName}` : null].filter(Boolean).join(" ");

  const inc = await c.query<{ id: string }>(
    `insert into incidents (territory_id, area_id, problem_type_id, severity, active_hazard, passage, accessibility, location, location_text,
       title, priority_band, priority_breakdown)
     select $1, $2, $3, $4, $5, $6, $7, location, location_text, $8, $9, $10 from reports where id = $11
     returning id`,
    [territoryId, areaId, ev.problemTypeId, ev.severity, activeHazard, ev.passage, ev.accessibility, title, priority.band, priority.breakdown, reportId],
  );
  const incidentId = inc.rows[0].id;
  await insertLink(c, { reportId, incidentId, origin, decisionId: groupingDecisionId });
  // Textos del operador: una revisión nueva, un job. La revisión 1 se encola acá, no depende de assess_incident.
  await enqueueTextgen(c, { incidentId, revision: 1, territoryId });
  // Base de la IA (evaluación del reporte que lo creó): lo que vuelve a mandar al quitar una corrección humana.
  const assessed = { problemTypeId: ev.problemTypeId, severity: ev.severity, activeHazard, passage: ev.passage, accessibility: ev.accessibility };
  await c.query(
    `insert into incident_assessments (incident_id, incident_revision, ai_run_id, reports_considered, problem_type_id, severity, active_hazard,
       evidence_summary, changes, source_counts)
     values ($1, 1, $2, $3, $4, $5, $6, $7, '[]', $8)`,
    [incidentId, ev.aiRunId, [reportId], ev.problemTypeId, ev.severity, activeHazard,
      JSON.stringify({ source: "report_evaluation", evaluation_id: ev.id, assessed }), JSON.stringify({ reports: 1, sources: 1 })],
  );
  return { incidentId, priorityBand: priority.band };
}
