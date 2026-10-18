import type { Db } from "../db/pool";
import type { IncidentListItem, IncidentListResponse } from "@/shared/contracts/incident";

export type ListFilters = { areaId?: string; problemType?: string; priorityBand?: string; status?: string; sort: "priority" | "recent" | "reports" };

const ORDER = {
  priority: `i.active_hazard desc, case i.priority_band when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end, i.created_at asc, i.id`,
  recent: "i.created_at desc, i.id",
  reports: "report_count desc, i.created_at asc, i.id",
};

/** Lista del operador. Por defecto oculta archivados; el orden por reportes es solo de visualización. */
export async function listIncidents(db: Db, territoryId: string, f: ListFilters): Promise<IncidentListItem[]> {
  const { rows } = await db.query(
    `select i.id, coalesce(i.title, pt.name, 'Incidente') as title, pt.slug as pt_slug, pt.name as pt_name, i.severity, i.active_hazard,
       i.priority_band, i.status, i.dispatch_blocked, a.id as area_id, a.name as area_name, i.location_text,
       st_x(i.location::geometry) as lon, st_y(i.location::geometry) as lat, i.created_at, i.updated_at,
       (select count(*) from report_incident_links l where l.incident_id = i.id and l.active)::int as report_count,
       (select count(distinct r.citizen_session_id) from report_incident_links l join reports r on r.id = l.report_id
          where l.incident_id = i.id and l.active)::int as source_count,
       coalesce((select array_agg(distinct ri.kind) from review_items ri where ri.entity_type = 'incident' and ri.entity_id = i.id and ri.status = 'open'), '{}') as review_kinds
     from incidents i
     left join problem_types pt on pt.id = i.problem_type_id
     left join areas a on a.id = i.area_id
     where i.territory_id = $1
       and ($2::uuid is null or i.area_id = $2)
       and ($3::text is null or pt.slug = $3)
       and ($4::text is null or i.priority_band = $4)
       and (($5::text is null and i.status <> 'archived') or i.status = $5)
     order by ${ORDER[f.sort]}
     limit 500`,
    [territoryId, f.areaId ?? null, f.problemType ?? null, f.priorityBand ?? null, f.status ?? null],
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, problemType: r.pt_slug ? { slug: r.pt_slug, name: r.pt_name } : null, severity: r.severity,
    activeHazard: r.active_hazard, priorityBand: r.priority_band, status: r.status, dispatchBlocked: r.dispatch_blocked,
    openReviewKinds: r.review_kinds, area: r.area_id ? { id: r.area_id, name: r.area_name } : null, locationText: r.location_text,
    lon: r.lon, lat: r.lat, reportCount: r.report_count, sourceCount: r.source_count,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  }));
}

/** Contadores del encabezado (ALCANCE §7: pendientes, por revisar y resueltos) sobre todo el territorio, agregados en la base. */
export async function summarizeIncidents(
  db: Db,
  territoryId: string,
  days: { today: string; yesterday: string },
): Promise<NonNullable<IncidentListResponse["summary"]>> {
  const { rows } = await db.query<NonNullable<IncidentListResponse["summary"]>>(
    `select count(*) filter (where i.status in ('open', 'assigned', 'in_progress'))::int as "active",
       count(*) filter (where i.status in ('open', 'assigned', 'in_progress') and i.priority_band = 'high')::int as "activeHigh",
       count(*) filter (where i.status <> 'archived' and exists (select 1 from review_items ri
          where ri.entity_type = 'incident' and ri.entity_id = i.id and ri.status = 'open'))::int as "review",
       count(*) filter (where i.status = 'resolved' and i.resolved_at >= $2::timestamptz)::int as "resolvedToday",
       count(*) filter (where i.status = 'resolved' and i.resolved_at >= $3::timestamptz and i.resolved_at < $2::timestamptz)::int as "resolvedYesterday"
     from incidents i
     where i.territory_id = $1`,
    [territoryId, days.today, days.yesterday],
  );
  return rows[0];
}
