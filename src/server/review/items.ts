import type { Db } from "../db/pool";
import type { ReviewKind } from "@/shared/contracts/review";

export type { ReviewKind };

/**
 * Abre un ítem de revisión, idempotente por (kind, entidad) mientras esté abierto.
 * Sobre un incidente, bloquea el despacho automático hasta resolverlo.
 */
export async function openReviewItem(
  db: Db,
  i: { territoryId: string | null; kind: ReviewKind; entityType: string; entityId: string; reasons?: unknown[]; evidenceRefs?: unknown[] },
): Promise<{ id: string; created: boolean }> {
  const ins = await db.query<{ id: string }>(
    `insert into review_items (territory_id, kind, entity_type, entity_id, reasons, evidence_refs)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (kind, entity_type, entity_id) where status = 'open' do nothing returning id`,
    [i.territoryId, i.kind, i.entityType, i.entityId, JSON.stringify(i.reasons ?? []), JSON.stringify(i.evidenceRefs ?? [])],
  );
  if (i.entityType === "incident") {
    await db.query("update incidents set dispatch_blocked = true, updated_at = now() where id = $1", [i.entityId]);
  }
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const ex = await db.query<{ id: string }>(
    "select id from review_items where kind = $1 and entity_type = $2 and entity_id = $3 and status = 'open'",
    [i.kind, i.entityType, i.entityId],
  );
  return { id: ex.rows[0].id, created: false };
}
