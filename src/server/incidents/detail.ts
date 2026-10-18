import type { Db } from "../db/pool";
import { notFound } from "../errors";
import { isUuid } from "../ids";
import { ACTIVE_ASSIGNMENT_STATUSES, type AssignmentStatus } from "@/shared/contracts/assignment";
import type { OverrideField } from "@/shared/contracts/incident";
import type { IncidentDetailResponse } from "@/shared/contracts/incident-detail";
import { incidentCardSelect, toIncidentListItem, type IncidentCardRow } from "./queries";
import { latestTexts } from "./texts";

type Detail = IncidentDetailResponse;
type DetailRow = IncidentCardRow & {
  territory_id: string; revision: number; passage: Detail["incident"]["passage"]; accessibility: Detail["incident"]["accessibility"];
  summary: string | null; priority_breakdown: { rules?: string[]; promoted_by_age?: boolean } | null;
};

const EVENT_LIMIT = 50;

/**
 * Detalle del incidente para el operador: la tarjeta de la lista (misma consulta) más revisión, correcciones vigentes,
 * reportes vinculados con su relato y fotos, orden activa, ítems de revisión abiertos e historial. Todo de la base.
 * Devuelve el territorio para que la ruta autorice; id que no es uuid o inexistente ⇒ 404.
 */
export async function getIncidentDetail(db: Db, incidentId: string): Promise<{ territoryId: string; body: Detail }> {
  if (!isUuid(incidentId)) throw notFound("Incidente inexistente.");
  const { rows } = await db.query<DetailRow>(
    `${incidentCardSelect("i.territory_id, i.revision, i.passage, i.accessibility, i.summary, i.priority_breakdown")} where i.id = $1`,
    [incidentId],
  );
  const inc = rows[0];
  if (!inc) throw notFound("Incidente inexistente.");

  const [texts, overrides, reports, assignment, reviewItems, events, types] = await Promise.all([
    latestTexts(db, incidentId),
    db.query<{ field: OverrideField; value: unknown; reason: string; created_at: Date }>(
      "select field, value, reason, created_at from incident_overrides where incident_id = $1 and removed_at is null order by created_at, id",
      [incidentId],
    ),
    db.query<{ id: string; public_code: string | null; confirmed_at: Date | null; origin: "auto" | "manual"; description: string | null; messages: { role: "citizen" | "assistant" | "system"; body: string; createdAt: string }[]; photo_ids: string[] }>(
      `select r.id, r.public_code, r.confirmed_at, l.origin, r.description,
         coalesce((select json_agg(json_build_object('role', m.role, 'body', m.body, 'createdAt', m.created_at) order by m.seq)
                   from conversations cv join messages m on m.conversation_id = cv.id
                   -- Solo el relato del ciudadano, como lo lee el pipeline (drafts.ts): sin respuestas del asistente
                   -- (una consulta de estado cita otros reportes de la sesión, de cualquier territorio), sin
                   -- respuestas de control («sí», «enviar») ni marcadores de foto.
                   where cv.report_id = r.id and m.role = 'citizen' and not m.control_reply and m.body <> '[foto]'), '[]') as messages,
         coalesce((select array_agg(at.id order by at.created_at, at.id) from attachments at where at.report_id = r.id and at.purpose = 'original'), '{}') as photo_ids
       from report_incident_links l join reports r on r.id = l.report_id
       where l.incident_id = $1 and l.active
       order by r.confirmed_at, r.id`,
      [incidentId],
    ),
    db.query<{ id: string; status: AssignmentStatus; version: number; unit_name: string; review_blocked: boolean; offered_at: Date }>(
      `select a.id, a.status, a.version, u.name as unit_name, a.review_blocked, a.offered_at
       from assignments a join response_units u on u.id = a.unit_id
       where a.incident_id = $1 and a.status = any($2) order by a.offered_at desc, a.id limit 1`,
      [incidentId, ACTIVE_ASSIGNMENT_STATUSES],
    ),
    // Lo que tiene abierto en revisión: el incidente, sus órdenes, sus reportes, y los posibles duplicados que lo
    // listan como candidato (también le bloquean el despacho, ver recomputeDispatchBlocked).
    db.query<{ id: string; kind: Detail["openReviewItems"][number]["kind"]; reasons: Record<string, unknown>[]; created_at: Date }>(
      `select ri.id, ri.kind, ri.reasons, ri.created_at from review_items ri
       where ri.status = 'open' and (
         (ri.entity_type = 'incident' and ri.entity_id = $1)
         or (ri.entity_type = 'assignment' and ri.entity_id in (select id from assignments where incident_id = $1))
         or (ri.entity_type = 'report' and ri.entity_id in (select report_id from report_incident_links where incident_id = $1 and active))
         or (ri.kind = 'uncertain_duplicate' and ri.evidence_refs @> jsonb_build_array(jsonb_build_object('candidate_incident_ids', jsonb_build_array($1::text))))
       )
       order by ri.created_at, ri.id`,
      [incidentId],
    ),
    // Historial: del incidente, de sus reportes vinculados y de sus órdenes. Los registros de idempotencia de los
    // pedidos del operador (`operator_request`) no se listan: el evento de dominio de cada pedido ya está.
    db.query<{ kind: string; actor_type: string; created_at: Date; data: Record<string, unknown> }>(
      `select e.kind, e.actor_type, e.created_at, e.data from events e
       where ((e.entity_type = 'incident' and e.entity_id = $1 and e.kind <> 'operator_request')
         or (e.entity_type = 'report' and e.entity_id in (select report_id from report_incident_links where incident_id = $1 and active))
         or (e.entity_type = 'assignment' and e.entity_id in (select id from assignments where incident_id = $1)))
       order by e.created_at desc, e.id desc limit $2`,
      [incidentId, EVENT_LIMIT],
    ),
    db.query<{ id: string; slug: string; name: string }>(
      `select pt.id, pt.slug, pt.name from problem_types pt join territory_problem_types t on t.problem_type_id = pt.id
       where t.territory_id = $1 and t.enabled and pt.active order by pt.sort_order, pt.name`,
      [inc.territory_id],
    ),
  ]);

  const band = overrides.rows.find((o) => o.field === "priority_band")?.value as Detail["incident"]["bandOverride"] | undefined;
  const bd = inc.priority_breakdown ?? {};
  const a = assignment.rows[0];
  const body: Detail = {
    incident: {
      ...toIncidentListItem(inc),
      revision: inc.revision,
      passage: inc.passage,
      accessibility: inc.accessibility,
      summary: inc.summary,
      explainPriority: texts.explain_priority,
      priorityRules: [...(bd.rules ?? []), ...(bd.promoted_by_age ? ["promoted_by_age"] : [])],
      bandOverride: band ?? null,
    },
    overrides: overrides.rows.map((o) => ({ field: o.field, value: o.value, reason: o.reason, createdAt: o.created_at.toISOString() })),
    reports: reports.rows.map((r) => ({
      id: r.id,
      publicCode: r.public_code,
      confirmedAt: r.confirmed_at?.toISOString() ?? null,
      linkOrigin: r.origin,
      description: r.description,
      messages: r.messages.map((m) => ({ role: m.role, body: m.body, createdAt: new Date(m.createdAt).toISOString() })),
      photoIds: r.photo_ids,
    })),
    activeAssignment: a
      ? { id: a.id, status: a.status, version: a.version, unitName: a.unit_name, reviewBlocked: a.review_blocked, offeredAt: a.offered_at.toISOString() }
      : null,
    openReviewItems: reviewItems.rows.map((r) => ({ id: r.id, kind: r.kind, reasons: Array.isArray(r.reasons) ? r.reasons : [], createdAt: r.created_at.toISOString() })),
    events: events.rows.map((e) => ({ kind: e.kind, actorType: e.actor_type, createdAt: e.created_at.toISOString(), data: e.data ?? {} })),
    problemTypes: types.rows,
    generatedAt: new Date().toISOString(),
  };
  return { territoryId: inc.territory_id, body };
}
