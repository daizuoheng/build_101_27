import type { Db } from "../db/pool";
import { notFound } from "../errors";
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  allowedActions,
  type AssignmentStatus,
  type UnitAssignmentCard,
  type UnitInboxResponse,
} from "@/shared/contracts/assignment";

type Row = {
  id: string; status: AssignmentStatus; version: number; review_blocked: boolean; distance_m: number | null; reasons: unknown;
  offered_at: Date; accepted_at: Date | null; started_at: Date | null;
  incident_id: string; title: string; problem_type: string | null; priority_band: UnitAssignmentCard["incident"]["priorityBand"];
  priority_breakdown: { rules?: string[] } | null; active_hazard: boolean; location_text: string | null; area_name: string | null;
  lon: number; lat: number; summary: string | null; citizen_texts: string[]; photo_ids: string[];
};

/**
 * Bandeja de la unidad: sus órdenes activas, de la más urgente a la menos. Todo sale de la base; los textos
 * ciudadanos son los originales (evidencia) y las fotos se referencian por id, nunca por URL pública.
 */
export async function getUnitInbox(db: Db, unitId: string): Promise<UnitInboxResponse> {
  const unit = await db.query<{ id: string; name: string; unit_kind: string; capacity: number; active_orders: number }>(
    `select u.id, u.name, u.unit_kind, u.capacity,
       (select count(*) from assignments a where a.unit_id = u.id and a.status = any($2))::int as active_orders
     from response_units u where u.id = $1`,
    [unitId, ACTIVE_ASSIGNMENT_STATUSES],
  );
  const u = unit.rows[0];
  if (!u) throw notFound("Unidad inexistente.");

  const { rows } = await db.query<Row>(
    `select a.id, a.status, a.version, a.review_blocked, a.distance_m, a.reasons, a.offered_at, a.accepted_at, a.started_at,
       i.id as incident_id, coalesce(i.title, pt.name, 'Incidente') as title, pt.name as problem_type, i.priority_band,
       i.priority_breakdown, i.active_hazard, i.location_text, ar.name as area_name,
       st_x(i.location::geometry) as lon, st_y(i.location::geometry) as lat, i.summary,
       coalesce((select array_agg(m.body order by r.confirmed_at, m.seq)
                 from report_incident_links l
                 join reports r on r.id = l.report_id
                 join conversations c on c.report_id = r.id
                 join messages m on m.conversation_id = c.id
                 where l.incident_id = i.id and l.active and m.role = 'citizen' and m.body <> '[foto]'), '{}') as citizen_texts,
       coalesce((select array_agg(at.id order by at.created_at)
                 from report_incident_links l join attachments at on at.report_id = l.report_id
                 where l.incident_id = i.id and l.active and at.purpose = 'original'), '{}') as photo_ids
     from assignments a
     join incidents i on i.id = a.incident_id
     left join problem_types pt on pt.id = i.problem_type_id
     left join areas ar on ar.id = i.area_id
     where a.unit_id = $1 and a.status = any($2)
     order by i.active_hazard desc,
       case i.priority_band when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end,
       a.offered_at, a.id`,
    [unitId, ACTIVE_ASSIGNMENT_STATUSES],
  );

  return {
    unit: { id: u.id, name: u.name, kind: u.unit_kind, capacity: u.capacity, activeOrders: u.active_orders },
    assignments: rows.map((r) => ({
      id: r.id,
      status: r.status,
      version: r.version,
      reviewBlocked: r.review_blocked,
      allowedActions: allowedActions(r.status, "unit", r.review_blocked),
      distanceM: r.distance_m,
      reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [],
      offeredAt: r.offered_at.toISOString(),
      acceptedAt: r.accepted_at?.toISOString() ?? null,
      startedAt: r.started_at?.toISOString() ?? null,
      incident: {
        id: r.incident_id,
        title: r.title,
        problemType: r.problem_type,
        priorityBand: r.priority_band,
        priorityRules: r.priority_breakdown?.rules ?? [],
        activeHazard: r.active_hazard,
        locationText: r.location_text,
        areaName: r.area_name,
        lon: r.lon,
        lat: r.lat,
        citizenTexts: r.citizen_texts,
        photoIds: r.photo_ids,
        summary: r.summary,
      },
    })),
    generatedAt: new Date().toISOString(),
  };
}
