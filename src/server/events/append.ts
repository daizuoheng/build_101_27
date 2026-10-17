import type { Db } from "../db/pool";

export type EventInput = {
  entityType: string;
  entityId: string;
  kind: string;
  actorType: "system" | "operator" | "unit" | "citizen";
  actorId?: string | null;
  data?: Record<string, unknown>;
};

/** Registro de solo inserción. */
export async function appendEvent(db: Db, e: EventInput): Promise<void> {
  await db.query(
    "insert into events (entity_type, entity_id, kind, actor_type, actor_id, data) values ($1, $2, $3, $4, $5, $6)",
    [e.entityType, e.entityId, e.kind, e.actorType, e.actorId ?? null, e.data ?? {}],
  );
}
