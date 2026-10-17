import type { Db } from "../db/pool";
import type { Actor, RemoveOverride, SetOverride } from "../contracts";
import type { EvaluationPolicy } from "../config/policies";
import { appendEvent } from "../events/append";
import { badRequest, conflict, notFound } from "../errors";
import { locatePoint } from "../geo/locate";
import { enqueue } from "../jobs/queue";
import { openReviewItem } from "../review/items";
import { chosenProbability } from "../ai/jev/thresholds";
import type { IncidentAssessmentResult } from "../ai/jev/assess-incident";
import { ACTIVE_ASSIGNMENT_STATUSES } from "@/shared/contracts/assignment";
import type { OverrideField, OverrideValue } from "@/shared/contracts/incident";

export type Severity = "low" | "medium" | "high" | "undetermined";
export type Passage = "total" | "partial" | "none" | "undetermined";
export type Accessibility = "affected" | "not_affected" | "undetermined";
export type Band = "high" | "medium" | "low" | "unknown";

/** Campos del incidente que decide la evaluación (los que puede cambiar Jev). */
export type Assessed = { problemTypeId: string | null; severity: Severity; activeHazard: boolean; passage: Passage; accessibility: Accessibility };
export type LiveOverride = { field: OverrideField; value: unknown };
export type Discrepancy = { field: string; assessed: unknown; effective: unknown; override: true };

const OPEN_STATUSES = ["open", "assigned", "in_progress"];
const ACTIVE: readonly string[] = ACTIVE_ASSIGNMENT_STATUSES;

/**
 * Resultado de Jev sobre los valores vigentes. Pura. Un valor de la IA reemplaza al vigente solo si su probabilidad
 * alcanza `min_change` y no es indeterminado; un peligro activo solo se apaga con evidencia firme (`min_hazard_off`).
 */
export function mergeAssessment(previous: Assessed, ai: IncidentAssessmentResult, policy: EvaluationPolicy["assessment"]): Assessed {
  const firm = (a: { choice: string; probabilities: Record<string, number> }) => chosenProbability(a as never) >= policy.min_change;
  const pick = <T extends string>(a: IncidentAssessmentResult["severity"], prev: T, unknown: string[]): T =>
    firm(a) && !unknown.includes(a.choice) ? (a.choice as T) : prev;

  let activeHazard = previous.activeHazard;
  if (ai.activeFire.choice === "yes" && firm(ai.activeFire)) activeHazard = true;
  else if (ai.activeFire.choice === "no" && chosenProbability(ai.activeFire) >= policy.min_hazard_off) activeHazard = false;

  return {
    problemTypeId: ai.problemTypeId && firm(ai.problemType) ? ai.problemTypeId : previous.problemTypeId,
    severity: pick(ai.severity, previous.severity, ["undetermined"]),
    passage: pick(ai.passage, previous.passage, ["undetermined"]),
    accessibility: pick(ai.accessibility, previous.accessibility, ["undetermined"]),
    activeHazard,
  };
}

/**
 * Aplica las correcciones humanas vigentes sobre lo evaluado. Pura. El override gana siempre; si difiere de lo
 * evaluado, queda la discrepancia registrada. `priority_band` no es un campo evaluado: se devuelve aparte.
 */
export function applyOverrides(assessed: Assessed, overrides: LiveOverride[]): { effective: Assessed; bandOverride: Band | null; discrepancies: Discrepancy[] } {
  const effective = { ...assessed };
  const discrepancies: Discrepancy[] = [];
  let bandOverride: Band | null = null;
  for (const o of overrides) {
    if (o.field === "problem_type_id") {
      effective.problemTypeId = o.value as string;
      if (assessed.problemTypeId !== effective.problemTypeId) discrepancies.push({ field: "problem_type_id", assessed: assessed.problemTypeId, effective: effective.problemTypeId, override: true });
    } else if (o.field === "severity") {
      effective.severity = o.value as Severity;
      if (assessed.severity !== effective.severity) discrepancies.push({ field: "severity", assessed: assessed.severity, effective: effective.severity, override: true });
    } else if (o.field === "priority_band") {
      bandOverride = o.value as Band;
    }
    // location y status se aplican al momento de la corrección (no los decide Jev).
  }
  return { effective, bandOverride, discrepancies };
}

/** Orden activa que ya no corresponde (cambió tipo, ubicación o capacidad requerida): se bloquea para iniciar/completar y va a revisión. */
export async function markIncompatibleAssignment(db: Db, incident: { id: string; territoryId: string }, reasons: Record<string, unknown>[]): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `update assignments set review_blocked = true, version = version + 1, updated_at = now()
     where incident_id = $1 and status = any($2) returning id`,
    [incident.id, ACTIVE],
  );
  if (!rows[0]) return null;
  await openReviewItem(db, {
    territoryId: incident.territoryId, kind: "incompatible_assignment", entityType: "assignment", entityId: rows[0].id,
    reasons, evidenceRefs: [{ incident_id: incident.id }],
  });
  await appendEvent(db, { entityType: "assignment", entityId: rows[0].id, kind: "review_blocked", actorType: "system", data: { reasons } });
  return rows[0].id;
}

async function lockIncident(db: Db, incidentId: string) {
  const pre = await db.query<{ territory_id: string }>("select territory_id from incidents where id = $1", [incidentId]);
  if (!pre.rows[0]) throw notFound("Incidente inexistente.");
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [pre.rows[0].territory_id]); // mismo orden que links/pipeline
  const { rows } = await db.query<{ territory_id: string; revision: number; status: string }>(
    "select territory_id, revision, status from incidents where id = $1 for update",
    [incidentId],
  );
  return rows[0];
}

async function bumpAndReassess(db: Db, incidentId: string, territoryId: string, reason: string): Promise<number> {
  const { rows } = await db.query<{ revision: number }>(
    "update incidents set revision = revision + 1, updated_at = now() where id = $1 returning revision",
    [incidentId],
  );
  await enqueue(db, { kind: "assess_incident", entityType: "incident", entityId: incidentId, entityRevision: rows[0].revision, territoryId, payload: { reason } });
  return rows[0].revision;
}

const requireOperator = (actor: Actor) => {
  if (actor.type !== "operator" || !actor.id) throw badRequest("operator_required", "Las correcciones las hace un operador identificado.");
  return actor.id;
};

/**
 * Corrección humana por campo (`SetOverride` de src/server/contracts.ts). Reemplaza la corrección vigente del mismo
 * campo, sobrevive a las reevaluaciones y encola `assess_incident`. Ubicación y estado se aplican en el acto.
 */
export async function setOverride(
  db: Db,
  { incidentId, override, reason, actor, expectedRevision }: Parameters<SetOverride>[1],
): Promise<{ incidentId: string; revision: number }> {
  const actorId = requireOperator(actor);
  const inc = await lockIncident(db, incidentId);
  if (inc.revision !== expectedRevision) throw conflict("revision_conflict", "El incidente cambió mientras lo corregías. Refrescá y volvé a intentar.");
  if (!OPEN_STATUSES.includes(inc.status)) throw conflict("incident_closed", "El incidente ya está cerrado.");
  const o: OverrideValue = override;

  if (o.field === "problem_type_id") {
    const pt = await db.query("select 1 from problem_types pt join territory_problem_types t on t.problem_type_id = pt.id where pt.id = $1 and t.territory_id = $2 and t.enabled", [o.value, inc.territory_id]);
    if (!pt.rows[0]) throw badRequest("invalid_problem_type", "Ese tipo no está habilitado en el territorio.");
  }
  if (o.field === "location") {
    const loc = await locatePoint(db, o.value.lon, o.value.lat);
    if (!loc || loc.territoryId !== inc.territory_id) throw badRequest("out_of_coverage", "Ese punto queda fuera del territorio del incidente.");
    await db.query(
      `update incidents set location = st_setsrid(st_makepoint($2, $3), 4326)::geography, area_id = $4,
         location_text = coalesce($5, location_text) where id = $1`,
      [incidentId, o.value.lon, o.value.lat, loc.areaId, o.value.text ?? null],
    );
  }

  await db.query("update incident_overrides set removed_at = now(), removed_by = $3 where incident_id = $1 and field = $2 and removed_at is null", [incidentId, o.field, actorId]);
  await db.query(
    "insert into incident_overrides (incident_id, field, value, reason, created_by) values ($1, $2, $3, $4, $5)",
    [incidentId, o.field, JSON.stringify(o.value), reason, actorId],
  );
  await appendEvent(db, { entityType: "incident", entityId: incidentId, kind: "override_set", actorType: "operator", actorId, data: { field: o.field, value: o.value, reason } });

  if (o.field === "status") {
    await closeByOperator(db, { incidentId, territoryId: inc.territory_id, status: o.value, reason, actorId });
    const { rows } = await db.query<{ revision: number }>("update incidents set revision = revision + 1, updated_at = now() where id = $1 returning revision", [incidentId]);
    return { incidentId, revision: rows[0].revision };
  }
  if (o.field === "problem_type_id" || o.field === "location") {
    await markIncompatibleAssignment(db, { id: incidentId, territoryId: inc.territory_id }, [{ code: "override_changed", field: o.field }]);
  }
  return { incidentId, revision: await bumpAndReassess(db, incidentId, inc.territory_id, `override:${o.field}`) };
}

/** Cierre manual: la orden activa se completa (resuelto) o cancela (archivado) en la misma transacción y se replanifica. */
async function closeByOperator(db: Db, i: { incidentId: string; territoryId: string; status: "resolved" | "archived"; reason: string; actorId: string }) {
  const resolved = i.status === "resolved";
  await db.query(
    `update incidents set status = $2, resolved_at = case when $2 = 'resolved' then now() else resolved_at end,
       archived_at = case when $2 = 'archived' then now() else archived_at end, dispatch_blocked = false, updated_at = now() where id = $1`,
    [i.incidentId, i.status],
  );
  const closed = await db.query<{ id: string }>(
    `update assignments set status = $3, closed_reason = $4, completed_at = case when $3 = 'completed' then now() else completed_at end,
       version = version + 1, updated_at = now()
     where incident_id = $1 and status = any($2) returning id`,
    [i.incidentId, ACTIVE, resolved ? "completed" : "cancelled", resolved ? "resolved_by_operator" : "archived_by_operator"],
  );
  for (const a of closed.rows) {
    await appendEvent(db, { entityType: "assignment", entityId: a.id, kind: resolved ? "completed" : "cancelled", actorType: "operator", actorId: i.actorId, data: { reason: i.reason, by: "operator_close" } });
  }
  await db.query(
    `update review_items set status = 'dismissed', resolution = jsonb_build_object('action', 'dismiss', 'reason', 'incident_' || $2::text),
       resolved_by = $3, resolved_at = now(), updated_at = now() where entity_type = 'incident' and entity_id = $1 and status = 'open'`,
    [i.incidentId, i.status, i.actorId],
  );
  await enqueue(db, { kind: "plan", entityType: "territory", entityId: i.territoryId, entityRevision: 0, territoryId: i.territoryId, dedupeSuffix: `closed:${i.incidentId}` });
}

/** Quita la corrección vigente de un campo (`RemoveOverride`); la próxima reevaluación vuelve a mandar. Reabrir no se hace así. */
export async function removeOverride(
  db: Db,
  { incidentId, field, actor }: Parameters<RemoveOverride>[1],
): Promise<{ incidentId: string; revision: number }> {
  const actorId = requireOperator(actor);
  if (field === "status") throw badRequest("cannot_reopen", "Un incidente cerrado no se reabre quitando la corrección; un reporte nuevo crea una recurrencia.");
  const inc = await lockIncident(db, incidentId);
  const res = await db.query("update incident_overrides set removed_at = now(), removed_by = $3 where incident_id = $1 and field = $2 and removed_at is null", [incidentId, field, actorId]);
  if (!res.rowCount) throw notFound("No hay una corrección vigente para ese campo.");
  await appendEvent(db, { entityType: "incident", entityId: incidentId, kind: "override_removed", actorType: "operator", actorId, data: { field } });
  return { incidentId, revision: await bumpAndReassess(db, incidentId, inc.territory_id, `override_removed:${field}`) };
}

export async function liveOverrides(db: Db, incidentId: string): Promise<LiveOverride[]> {
  const { rows } = await db.query<{ field: OverrideField; value: unknown }>(
    "select field, value from incident_overrides where incident_id = $1 and removed_at is null order by created_at",
    [incidentId],
  );
  return rows;
}

setOverride satisfies SetOverride;
removeOverride satisfies RemoveOverride;
