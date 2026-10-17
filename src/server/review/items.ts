import type { Db } from "../db/pool";
import type { ReviewKind } from "@/shared/contracts/review";

export type { ReviewKind };

/**
 * Abre un ítem de revisión: uno abierto por (kind, entidad). Si ya hay uno abierto del mismo tipo, no se duplica,
 * pero sus motivos y referencias de evidencia se suman a los existentes (sin repetir): un motivo nuevo nunca se pierde.
 * Sobre un incidente, bloquea el despacho automático hasta resolverlo.
 */
export async function openReviewItem(
  db: Db,
  i: { territoryId: string | null; kind: ReviewKind; entityType: string; entityId: string; reasons?: unknown[]; evidenceRefs?: unknown[] },
): Promise<{ id: string; created: boolean }> {
  const { rows } = await db.query<{ id: string; inserted: boolean }>(
    `insert into review_items (territory_id, kind, entity_type, entity_id, reasons, evidence_refs)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (kind, entity_type, entity_id) where status = 'open' do update set
       reasons = (select coalesce(jsonb_agg(distinct x), '[]') from jsonb_array_elements(review_items.reasons || excluded.reasons) x),
       evidence_refs = (select coalesce(jsonb_agg(distinct x), '[]') from jsonb_array_elements(review_items.evidence_refs || excluded.evidence_refs) x),
       updated_at = now()
     returning id, (xmax = 0) as inserted`,
    [i.territoryId, i.kind, i.entityType, i.entityId, JSON.stringify(i.reasons ?? []), JSON.stringify(i.evidenceRefs ?? [])],
  );
  if (i.entityType === "incident") {
    await db.query("update incidents set dispatch_blocked = true, updated_at = now() where id = $1", [i.entityId]);
  }
  return { id: rows[0].id, created: rows[0].inserted };
}

/**
 * Incidentes cuyo despacho depende de un ítem: el incidente mismo, o los candidatos de un `uncertain_duplicate`
 * (que se abre sobre el reporte y bloquea a sus candidatos mientras se decide).
 */
export async function incidentsAffectedByReviewItem(db: Db, reviewItemId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select ri.entity_id as id from review_items ri where ri.id = $1 and ri.entity_type = 'incident'
     union
     select jsonb_array_elements_text(ref->'candidate_incident_ids')::uuid from review_items ri, jsonb_array_elements(ri.evidence_refs) ref
     where ri.id = $1 and ri.kind = 'uncertain_duplicate' and jsonb_typeof(ref->'candidate_incident_ids') = 'array'`,
    [reviewItemId],
  );
  return rows.map((r) => r.id);
}

/**
 * Recalcula `dispatch_blocked`: queda en true solo si sigue abierto algún ítem sobre el incidente o algún
 * `uncertain_duplicate` que lo lista como candidato. Llamar al cerrar ítems (contrato de `resolveReviewItem`).
 */
export async function recomputeDispatchBlocked(db: Db, incidentIds: string[]): Promise<{ id: string; dispatchBlocked: boolean }[]> {
  if (!incidentIds.length) return [];
  const { rows } = await db.query<{ id: string; dispatch_blocked: boolean }>(
    `update incidents i set dispatch_blocked = exists (
       select 1 from review_items ri where ri.status = 'open' and (
         (ri.entity_type = 'incident' and ri.entity_id = i.id)
         or (ri.kind = 'uncertain_duplicate' and ri.evidence_refs @> jsonb_build_array(jsonb_build_object('candidate_incident_ids', jsonb_build_array(i.id::text))))
       )
     ), updated_at = now()
     where i.id = any($1::uuid[]) returning i.id, i.dispatch_blocked`,
    [incidentIds],
  );
  return rows.map((r) => ({ id: r.id, dispatchBlocked: r.dispatch_blocked }));
}
