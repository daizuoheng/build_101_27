import type { Db } from "../db/pool";
import { getActivePolicy } from "../config/policies";
import { appendEvent } from "../events/append";
import { enqueue } from "../jobs/queue";
import { computePriority } from "../pipeline/priority";
import { applyOverrides, liveOverrides, markIncompatibleAssignment, type Assessed } from "./overrides";

/**
 * Último valor evaluado por la IA (sin correcciones humanas): la base sobre la que se aplican los overrides.
 * Se guarda en `incident_assessments.evidence_summary.assessed` (también al crear el incidente). Para incidentes
 * creados antes de guardarla, se reconstruye desde la evaluación del primer reporte (nunca desde las columnas, que
 * pueden contener correcciones humanas). Solo si tampoco hay evaluación se usan las columnas sin correcciones vigentes.
 */
export async function latestAssessed(db: Db, incidentId: string): Promise<Assessed> {
  const { rows } = await db.query<{ assessed: Assessed | null }>(
    `select evidence_summary->'assessed' as assessed from incident_assessments
     where incident_id = $1 and evidence_summary ? 'assessed' order by incident_revision desc limit 1`,
    [incidentId],
  );
  if (rows[0]?.assessed) return rows[0].assessed;

  const ev = await db.query<{ problem_type_id: string | null; severity: Assessed["severity"]; active_fire: string; photo_fire: number | null; passage: Assessed["passage"]; accessibility: Assessed["accessibility"] }>(
    `select e.problem_type_id, e.severity, e.active_fire, (e.answers->'fact_photo_shows_fire'->>'noul')::float8 as photo_fire, e.passage, e.accessibility
     from report_incident_links l join reports r on r.id = l.report_id
     join report_evaluations e on e.report_id = r.id and e.report_revision = r.confirmed_revision
     where l.incident_id = $1 and l.active order by r.confirmed_at, r.id limit 1`,
    [incidentId],
  );
  const e = ev.rows[0];
  if (e) {
    return {
      problemTypeId: e.problem_type_id, severity: e.severity, passage: e.passage, accessibility: e.accessibility,
      activeHazard: e.active_fire === "yes" || (e.photo_fire ?? 0) >= 0.5, // misma regla que indicatesActiveHazard
    };
  }
  const inc = await db.query<Assessed>(
    `select problem_type_id as "problemTypeId", severity, active_hazard as "activeHazard", passage, accessibility from incidents where id = $1`,
    [incidentId],
  );
  return inc.rows[0];
}

type Row = Assessed & { territory_id: string; created_at: Date; priority_band: string; revision: number; area_name: string | null };

/**
 * Valor efectivo = evaluado + correcciones vigentes, con prioridad por política. Escribe columnas, título y desglose;
 * sube la revisión y encola `plan` solo si cambió algo efectivo; bloquea la orden activa si cambió la capacidad
 * requerida (tipo o peligro activo nuevo). Llamar dentro de la transacción, con el incidente bloqueado.
 */
export async function recomputeEffective(
  db: Db,
  incidentId: string,
  assessed: Assessed,
  opts: { reason: string; extraChange?: boolean } = { reason: "recompute" },
): Promise<{ revision: number; changed: boolean; changes: Record<string, unknown>[]; discrepancies: Record<string, unknown>[]; band: string }> {
  const { rows } = await db.query<Row>(
    `select i.territory_id, i.created_at, i.priority_band, i.revision, a.name as area_name,
       i.problem_type_id as "problemTypeId", i.severity, i.active_hazard as "activeHazard", i.passage, i.accessibility
     from incidents i left join areas a on a.id = i.area_id where i.id = $1`,
    [incidentId],
  );
  const cur = rows[0];
  const overrides = await liveOverrides(db, incidentId);
  const overridden = new Set(overrides.map((o) => o.field));
  const { effective, bandOverride, discrepancies } = applyOverrides(assessed, overrides);
  const priorityPolicy = await getActivePolicy(db, cur.territory_id, "priority");
  const computed = computePriority(effective, cur.created_at, new Date(), priorityPolicy.config);
  const band = bandOverride ?? computed.band;
  const breakdown = { ...computed.breakdown, computed_band: computed.band, ...(bandOverride ? { band_override: bandOverride } : {}) };

  const column = { problemTypeId: "problem_type_id", severity: "severity", activeHazard: "active_hazard", passage: "passage", accessibility: "accessibility" } as const;
  const changes: Record<string, unknown>[] = (Object.keys(column) as (keyof Assessed)[])
    .filter((f) => cur[f] !== effective[f])
    .map((f) => ({ field: column[f], from: cur[f], to: effective[f], source: overridden.has(column[f] as never) ? "override" : "ai" }));
  if (cur.priority_band !== band) changes.push({ field: "priority_band", from: cur.priority_band, to: band, source: bandOverride ? "override" : "rules" });
  const changed = changes.length > 0 || !!opts.extraChange;

  const typeName = effective.problemTypeId
    ? (await db.query<{ name: string }>("select name from problem_types where id = $1", [effective.problemTypeId])).rows[0]?.name
    : null;
  const title = [typeName ?? "Problema sin clasificar", cur.area_name ? `— ${cur.area_name}` : null].filter(Boolean).join(" ");
  const upd = await db.query<{ revision: number }>(
    `update incidents set problem_type_id = $2, severity = $3, active_hazard = $4, passage = $5, accessibility = $6,
       priority_band = $7, priority_breakdown = $8, title = $9, revision = revision + $10, updated_at = now()
     where id = $1 returning revision`,
    [incidentId, effective.problemTypeId, effective.severity, effective.activeHazard, effective.passage, effective.accessibility,
      band, breakdown, title, changed ? 1 : 0],
  );

  const typeChanged = cur.problemTypeId !== effective.problemTypeId;
  const hazardOn = !cur.activeHazard && effective.activeHazard;
  if (typeChanged || hazardOn) {
    await markIncompatibleAssignment(db, { id: incidentId, territoryId: cur.territory_id }, [{ code: typeChanged ? "type_changed" : "active_hazard_detected", reason: opts.reason }]);
  }
  if (changed) {
    await appendEvent(db, { entityType: "incident", entityId: incidentId, kind: "effective_changed", actorType: "system", data: { reason: opts.reason, changes, band } });
    await enqueue(db, {
      kind: "plan", entityType: "territory", entityId: cur.territory_id, entityRevision: 0, territoryId: cur.territory_id,
      dedupeSuffix: `incident:${incidentId}:${upd.rows[0].revision}`,
    });
  }
  return { revision: upd.rows[0].revision, changed, changes: [...changes, ...discrepancies], discrepancies, band };
}
