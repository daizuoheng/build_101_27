import type { Db } from "../db/pool";
import { appendEvent } from "../events/append";
import { badRequest, conflict, notFound } from "../errors";
import { enqueue } from "../jobs/queue";

const OPEN_STATUSES = ["open", "assigned", "in_progress"];
const ACTIVE_ASSIGNMENT = ["offered", "accepted", "in_progress"];

type Actor = { actorType: "system" | "operator"; actorId: string | null };

async function lockTerritory(db: Db, territoryId: string) {
  // Reentrante dentro de la misma transacción: convive con el lock que ya toma el pipeline.
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [territoryId]);
}

/** El incidente cambió de evidencia: sube su revisión y encola su reevaluación. */
async function touchIncident(db: Db, incidentId: string, territoryId: string) {
  const { rows } = await db.query<{ revision: number }>(
    "update incidents set revision = revision + 1, updated_at = now() where id = $1 returning revision",
    [incidentId],
  );
  await enqueue(db, { kind: "assess_incident", entityType: "incident", entityId: incidentId, entityRevision: rows[0].revision, territoryId });
}

/** Desactiva el vínculo activo del reporte. Si el incidente queda sin reportes ⇒ `archived` y su orden activa cancelada. */
async function detach(db: Db, link: { id: string; incident_id: string; territory_id: string }, reason: string, actor: Actor) {
  await db.query("update report_incident_links set active = false, deactivated_at = now(), deactivation_reason = $2 where id = $1", [link.id, reason]);
  const left = await db.query<{ n: number }>("select count(*)::int as n from report_incident_links where incident_id = $1 and active", [link.incident_id]);
  if (left.rows[0].n > 0) {
    await touchIncident(db, link.incident_id, link.territory_id);
    return { archived: false };
  }
  await db.query(
    "update incidents set status = 'archived', archived_at = now(), revision = revision + 1, updated_at = now() where id = $1",
    [link.incident_id],
  );
  const cancelled = await db.query<{ id: string }>(
    `update assignments set status = 'cancelled', closed_reason = 'incident_archived', version = version + 1, updated_at = now()
     where incident_id = $1 and status = any($2) returning id`,
    [link.incident_id, ACTIVE_ASSIGNMENT],
  );
  await appendEvent(db, {
    entityType: "incident", entityId: link.incident_id, kind: "archived", ...actor,
    data: { reason: "no_reports", cancelled_assignment_ids: cancelled.rows.map((r) => r.id) },
  });
  return { archived: true };
}

async function activeLink(db: Db, reportId: string) {
  const { rows } = await db.query<{ id: string; incident_id: string; territory_id: string }>(
    `select l.id, l.incident_id, i.territory_id from report_incident_links l join incidents i on i.id = l.incident_id
     where l.report_id = $1 and l.active for update of l`,
    [reportId],
  );
  return rows[0] ?? null;
}

/** Inserta el vínculo activo y marca el reporte como agrupado. No reevalúa (lo decide el llamador). */
export async function insertLink(
  db: Db,
  { reportId, incidentId, origin, decisionId }: { reportId: string; incidentId: string; origin: "auto" | "manual"; decisionId: string | null },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into report_incident_links (report_id, incident_id, origin, grouping_decision_id) values ($1, $2, $3, $4) returning id",
    [reportId, incidentId, origin, decisionId],
  );
  await db.query("update reports set grouping = 'linked', updated_at = now() where id = $1", [reportId]);
  return rows[0].id;
}

/**
 * Asocia un reporte a un incidente abierto existente. Si el reporte ya tenía otro vínculo activo, lo desactiva
 * (y archiva el incidente anterior si queda vacío). Reevalúa los incidentes afectados. Llamar dentro de una transacción.
 */
export async function linkReport(
  db: Db,
  { reportId, incidentId, origin, decisionId, actorId }: { reportId: string; incidentId: string; origin: "auto" | "manual"; decisionId: string | null; actorId?: string | null },
): Promise<{ linkId: string; previousIncidentId: string | null }> {
  const inc = await db.query<{ territory_id: string; status: string }>("select territory_id, status from incidents where id = $1", [incidentId]);
  if (!inc.rows[0]) throw notFound("Incidente inexistente.");
  const territoryId = inc.rows[0].territory_id;
  await lockTerritory(db, territoryId);
  const locked = await db.query<{ status: string }>("select status from incidents where id = $1 for update", [incidentId]);
  if (!OPEN_STATUSES.includes(locked.rows[0].status)) throw conflict("incident_closed", "El incidente ya no está abierto.");
  const rep = await db.query<{ territory_id: string | null; status: string }>("select territory_id, status from reports where id = $1 for update", [reportId]);
  if (!rep.rows[0]) throw notFound("Reporte inexistente.");
  if (rep.rows[0].status !== "confirmed" || rep.rows[0].territory_id !== territoryId) {
    throw badRequest("report_not_linkable", "El reporte no está confirmado o es de otro territorio.");
  }

  const actor: Actor = origin === "manual" ? { actorType: "operator", actorId: actorId ?? null } : { actorType: "system", actorId: null };
  const prev = await activeLink(db, reportId);
  if (prev?.incident_id === incidentId) return { linkId: prev.id, previousIncidentId: null };
  if (prev) await detach(db, prev, "relinked", actor);

  const linkId = await insertLink(db, { reportId, incidentId, origin, decisionId });
  await touchIncident(db, incidentId, territoryId);
  await appendEvent(db, {
    entityType: "incident", entityId: incidentId, kind: "report_linked", ...actor,
    data: { report_id: reportId, origin, grouping_decision_id: decisionId, previous_incident_id: prev?.incident_id ?? null },
  });
  await appendEvent(db, { entityType: "report", entityId: reportId, kind: "linked", ...actor, data: { incident_id: incidentId, origin } });
  return { linkId, previousIncidentId: prev?.incident_id ?? null };
}

/**
 * Desasocia el reporte de su incidente. Si era el único reporte, el incidente queda `archived` y su orden activa
 * se cancela en la misma transacción; si no, se reevalúa. El reporte queda sin agrupar (`grouping = pending`).
 */
export async function unlinkReport(
  db: Db,
  { reportId, reason, actorId }: { reportId: string; reason: string; actorId: string | null },
): Promise<{ incidentId: string; archived: boolean }> {
  const first = await activeLink(db, reportId);
  if (!first) throw notFound("El reporte no está asociado a ningún incidente.");
  await lockTerritory(db, first.territory_id);
  const link = await activeLink(db, reportId); // relectura bajo el lock del territorio
  if (!link) throw notFound("El reporte no está asociado a ningún incidente.");
  const actor: Actor = { actorType: "operator", actorId };
  const { archived } = await detach(db, link, reason, actor);
  await db.query("update reports set grouping = 'pending', updated_at = now() where id = $1", [reportId]);
  await appendEvent(db, { entityType: "incident", entityId: link.incident_id, kind: "report_unlinked", ...actor, data: { report_id: reportId, reason, archived } });
  await appendEvent(db, { entityType: "report", entityId: reportId, kind: "unlinked", ...actor, data: { incident_id: link.incident_id, reason } });
  return { incidentId: link.incident_id, archived };
}
