// Cola de revisión del operador (Tarea 14): ítems de un territorio con la banda y el peligro de lo que afectan.

import type { Db } from "../db/pool";
import { actionsFor, type ReviewEntityType } from "./actions";
import type { ReviewItemView, ReviewKind } from "@/shared/contracts/review";

type Band = ReviewItemView["priorityBand"];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const TITLE_PREVIEW = 80;

/**
 * Ítems del territorio. Orden: peligro activo, banda (high, medium, low, unknown), antigüedad, id.
 * - sobre un incidente: banda, peligro y título del incidente;
 * - sobre una orden: los de su incidente;
 * - sobre un reporte: la banda más alta (y el peligro) de sus `candidate_incident_ids`, o `unknown`; título con el
 *   código y el comienzo de la descripción.
 */
export async function listReviewQueue(db: Db, territoryId: string, opts: { status?: "open" | "all"; limit?: number } = {}): Promise<ReviewItemView[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const { rows } = await db.query<{
    id: string; kind: ReviewKind; status: ReviewItemView["status"]; entity_type: ReviewEntityType; entity_id: string;
    reasons: Record<string, unknown>[]; evidence_refs: Record<string, unknown>[]; created_at: Date;
    band: Band; hazard: boolean; incident_title: string | null; public_code: string | null; description: string | null;
  }>(
    `with q as (
       select ri.*,
         coalesce(inc.priority_band, cand.band, 'unknown') as band,
         coalesce(inc.active_hazard, cand.hazard, false) as hazard,
         inc.title as incident_title, r.public_code, r.description
       from review_items ri
       left join assignments a on ri.entity_type = 'assignment' and a.id = ri.entity_id
       left join incidents inc on inc.id = case when ri.entity_type = 'incident' then ri.entity_id
                                               when ri.entity_type = 'assignment' then a.incident_id end
       left join reports r on ri.entity_type = 'report' and r.id = ri.entity_id
       left join lateral (
         select (array['high', 'medium', 'low', 'unknown'])[min(array_position(array['high', 'medium', 'low', 'unknown'], ci.priority_band))] as band,
                bool_or(ci.active_hazard) as hazard
         from incidents ci
         where ri.entity_type = 'report' and ci.id in (
           select jsonb_array_elements_text(ref->'candidate_incident_ids')::uuid
           from jsonb_array_elements(ri.evidence_refs) ref where jsonb_typeof(ref->'candidate_incident_ids') = 'array')
       ) cand on true
       where ri.territory_id = $1 and ($2 or ri.status = 'open')
     )
     select id, kind, status, entity_type, entity_id, reasons, evidence_refs, created_at, band, hazard, incident_title, public_code, description
     from q
     order by hazard desc, array_position(array['high', 'medium', 'low', 'unknown'], band), created_at, id
     limit $3`,
    [territoryId, opts.status === "all", limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    entityType: r.entity_type,
    entityId: r.entity_id,
    reasons: r.reasons,
    evidenceRefs: r.evidence_refs,
    createdAt: r.created_at.toISOString(),
    priorityBand: r.band,
    activeHazard: r.hazard,
    title: r.entity_type === "report" ? reportTitle(r.public_code, r.description) : r.incident_title ?? "Incidente sin título",
    actions: actionsFor(r.kind, r.entity_type),
  }));
}

function reportTitle(code: string | null, description: string | null): string {
  const text = (description ?? "").slice(0, TITLE_PREVIEW);
  const head = `Reporte ${code ?? "sin enviar"}`;
  return text ? `${head}: ${text}` : head;
}
