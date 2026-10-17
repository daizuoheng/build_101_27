// Acción del operador sobre una orden (cancelar o completar), idempotente por `idempotencyKey`: un reintento con la
// misma clave devuelve el mismo resultado sin volver a transicionar. Mismo patrón que la bandeja de unidad (Recepción).

import type { PoolClient } from "pg";
import { conflict, notFound } from "../errors";
import { appendEvent } from "../events/append";
import { transitionAssignment } from "./transitions";
import type { TransitionBody } from "@/shared/contracts/assignment";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Territorio de la orden, para autorizar al operador antes de actuar. */
export async function assignmentTerritory(db: PoolClient, assignmentId: string): Promise<string> {
  if (!UUID.test(assignmentId)) throw notFound("Orden inexistente.");
  const r = await db.query<{ territory_id: string }>(
    "select i.territory_id from assignments a join incidents i on i.id = a.incident_id where a.id = $1",
    [assignmentId],
  );
  if (!r.rows[0]) throw notFound("Orden inexistente.");
  return r.rows[0].territory_id;
}

export async function performOperatorAction(
  c: PoolClient,
  input: { assignmentId: string; userId: string; body: TransitionBody },
): Promise<{ assignmentId: string; status: string; version: number; replayed: boolean }> {
  const { assignmentId, userId, body } = input;
  // Serializa reintentos concurrentes con la misma clave sobre la misma orden (lock de dos claves: menos colisiones).
  await c.query("select pg_advisory_xact_lock(hashtext($1), hashtext($2))", [`operator_action:${assignmentId}`, body.idempotencyKey]);
  const prior = await c.query<{ data: { action: string; result: { status: string; version: number } } }>(
    `select data from events
     where entity_type = 'assignment' and entity_id = $1 and kind = 'operator_action' and actor_type = 'operator'
       and actor_id = $2 and data->>'idempotency_key' = $3
     order by created_at limit 1`,
    [assignmentId, userId, body.idempotencyKey],
  );
  const p = prior.rows[0];
  if (p) {
    if (p.data.action !== body.action) throw conflict("idempotency_key_reused", "Esa clave ya se usó para otra acción.");
    return { assignmentId, status: p.data.result.status, version: p.data.result.version, replayed: true };
  }

  const res = await transitionAssignment(c, {
    assignmentId,
    action: body.action,
    actor: { type: "operator", id: userId },
    expectedVersion: body.expectedVersion,
    reason: body.reason,
  });
  await appendEvent(c, {
    entityType: "assignment",
    entityId: assignmentId,
    kind: "operator_action",
    actorType: "operator",
    actorId: userId,
    data: { idempotency_key: body.idempotencyKey, action: body.action, result: { status: res.status, version: res.version } },
  });
  return { ...res, replayed: false };
}
