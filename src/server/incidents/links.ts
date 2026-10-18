import type { Db } from "../db/pool";
import type { Actor, LinkReport, UnlinkReport } from "../contracts";
import { appendEvent } from "../events/append";
import { badRequest, conflict, notFound } from "../errors";
import { enqueue } from "../jobs/queue";
import { openReviewItem } from "../review/items";
import { ACTIVE_ASSIGNMENT_STATUSES } from "@/shared/contracts/assignment";

const OPEN_STATUSES = ["open", "assigned", "in_progress"];
const ACTIVE_ASSIGNMENT: readonly string[] = ACTIVE_ASSIGNMENT_STATUSES;

type EventActor = { actorType: "system" | "operator" | "unit"; actorId: string | null };
const eventActor = (a: Actor): EventActor => ({ actorType: a.type, actorId: a.id });

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

/**
 * Desactiva el vínculo activo del reporte. Si el incidente abierto queda sin reportes ⇒ `archived`, con su orden
 * activa cancelada y sus ítems de revisión descartados, en la misma transacción. Uno ya resuelto conserva su estado.
 */
async function detach(db: Db, link: { id: string; incident_id: string; territory_id: string }, reason: string, actor: EventActor) {
  await db.query("update report_incident_links set active = false, deactivated_at = now(), deactivation_reason = $2 where id = $1", [link.id, reason]);
  const left = await db.query<{ n: number }>("select count(*)::int as n from report_incident_links where incident_id = $1 and active", [link.incident_id]);
  if (left.rows[0].n > 0) {
    await touchIncident(db, link.incident_id, link.territory_id);
    return { archived: false };
  }
  const archivedRow = await db.query(
    `update incidents set status = 'archived', archived_at = now(), dispatch_blocked = false, revision = revision + 1, updated_at = now()
     where id = $1 and status = any($2)`,
    [link.incident_id, OPEN_STATUSES],
  );
  if (!archivedRow.rowCount) return { archived: false }; // resuelto o ya archivado: no se reabre ni se cambia
  const cancelled = await db.query<{ id: string; unit_id: string }>(
    `update assignments set status = 'cancelled', closed_reason = 'incident_archived', version = version + 1, updated_at = now()
     where incident_id = $1 and status = any($2) returning id, unit_id`,
    [link.incident_id, ACTIVE_ASSIGNMENT],
  );
  for (const a of cancelled.rows) {
    await appendEvent(db, { entityType: "assignment", entityId: a.id, kind: "cancelled", ...actor, data: { reason: "incident_archived", unit_id: a.unit_id } });
  }
  // Se liberó capacidad de una unidad: replanificar el territorio (una vez por incidente archivado).
  if (cancelled.rows.length) {
    await enqueue(db, { kind: "plan", entityType: "territory", entityId: link.territory_id, entityRevision: 0, territoryId: link.territory_id, dedupeSuffix: `archived:${link.incident_id}` });
  }
  const dismissed = await db.query<{ id: string }>(
    `update review_items set status = 'dismissed', resolution = '{"action":"dismiss","reason":"incident_archived"}', resolved_at = now(), updated_at = now()
     where entity_type = 'incident' and entity_id = $1 and status = 'open' returning id`,
    [link.incident_id],
  );
  await appendEvent(db, {
    entityType: "incident", entityId: link.incident_id, kind: "archived", ...actor,
    data: { reason: "no_reports", cancelled_assignment_ids: cancelled.rows.map((r) => r.id), dismissed_review_item_ids: dismissed.rows.map((r) => r.id) },
  });
  return { archived: true };
}

/**
 * Vínculo activo del reporte. `lock` solo después de tomar el lock del territorio: orden de locks único
 * (territorio → filas) en link y unlink, para no generar deadlocks entre ambos.
 */
async function activeLink(db: Db, reportId: string, { lock }: { lock: boolean }) {
  const { rows } = await db.query<{ id: string; incident_id: string; territory_id: string }>(
    `select l.id, l.incident_id, i.territory_id from report_incident_links l join incidents i on i.id = l.incident_id
     where l.report_id = $1 and l.active ${lock ? "for update of l" : ""}`,
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
 * Firma: `LinkReport` de src/server/contracts.ts.
 */
export async function linkReport(
  db: Db,
  { reportId, incidentId, origin, groupingDecisionId, actor: who }: Parameters<LinkReport>[1],
): Promise<{ linkId: string; previousIncidentId: string | null }> {
  const decisionId = groupingDecisionId ?? null;
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

  const actor = eventActor(who);
  const prev = await activeLink(db, reportId, { lock: true });
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
 * se cancela en la misma transacción; si no, se reevalúa. El reporte no queda huérfano: pasa a revisión pendiente
 * de asociación (`grouping = review` + `uncertain_duplicate`), donde el operador lo asocia o crea su incidente.
 * Firma: `UnlinkReport` de src/server/contracts.ts.
 */
export async function unlinkReport(
  db: Db,
  { reportId, reason, actor: who }: Parameters<UnlinkReport>[1],
): Promise<{ incidentId: string; archived: boolean }> {
  const first = await activeLink(db, reportId, { lock: false }); // solo para saber el territorio
  if (!first) throw notFound("El reporte no está asociado a ningún incidente.");
  await lockTerritory(db, first.territory_id);
  const link = await activeLink(db, reportId, { lock: true }); // relectura con lock, bajo el lock del territorio
  if (!link) throw notFound("El reporte no está asociado a ningún incidente.");
  const actor = eventActor(who);
  const { archived } = await detach(db, link, reason, actor);
  await db.query("update reports set grouping = 'review', updated_at = now() where id = $1", [reportId]);
  await openReviewItem(db, {
    territoryId: link.territory_id, kind: "uncertain_duplicate", entityType: "report", entityId: reportId,
    reasons: [{ code: "unlinked_by_operator", reason }], evidenceRefs: [{ report_id: reportId, previous_incident_id: link.incident_id }],
  });
  await appendEvent(db, { entityType: "incident", entityId: link.incident_id, kind: "report_unlinked", ...actor, data: { report_id: reportId, reason, archived } });
  await appendEvent(db, { entityType: "report", entityId: reportId, kind: "unlinked", ...actor, data: { incident_id: link.incident_id, reason } });
  return { incidentId: link.incident_id, archived };
}

// Las implementaciones cumplen las firmas del contrato entre módulos (aceptan además un Pool, más general).
linkReport satisfies LinkReport;
unlinkReport satisfies UnlinkReport;
