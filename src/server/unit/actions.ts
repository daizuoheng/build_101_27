import type { PoolClient } from "pg";
import type { TransitionAssignment } from "../contracts";
import { appendEvent } from "../events/append";
import { conflict, DomainError, forbidden, notFound } from "../errors";
import type { TransitionBody } from "@/shared/contracts/assignment";

export type UnitActionResult = { assignmentId: string; status: string; version: number; replayed: boolean };

/**
 * Acción de la unidad sobre una orden, idempotente por `idempotencyKey` (un reintento del celular con la misma
 * clave devuelve el mismo resultado sin volver a transicionar). La transición en sí la hace `transitionAssignment`
 * (Operación). Identidad y unidad vienen de la sesión del servidor. Llamar dentro de una transacción.
 */
export async function performUnitAction(
  c: PoolClient,
  deps: { transitionAssignment: TransitionAssignment },
  input: { assignmentId: string; unitId: string; userId: string; body: TransitionBody },
): Promise<UnitActionResult> {
  const { assignmentId, unitId, userId, body } = input;
  if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) throw notFound("Orden inexistente.");
  // Serializa reintentos concurrentes con la misma clave.
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [`unit_action:${unitId}:${body.idempotencyKey}`]);

  const prior = await c.query<{ entity_id: string; data: { action: string; result: { status: string; version: number } } }>(
    `select entity_id, data from events
     where entity_type = 'assignment' and kind = 'unit_action' and actor_type = 'unit'
       and data->>'unit_id' = $1 and data->>'idempotency_key' = $2
     order by created_at limit 1`,
    [unitId, body.idempotencyKey],
  );
  const p = prior.rows[0];
  if (p) {
    if (p.entity_id !== assignmentId || p.data.action !== body.action) {
      throw conflict("idempotency_key_reused", "Esa clave ya se usó para otra acción.");
    }
    return { assignmentId, status: p.data.result.status, version: p.data.result.version, replayed: true };
  }

  const a = await c.query<{ unit_id: string }>("select unit_id from assignments where id = $1", [assignmentId]);
  if (!a.rows[0]) throw notFound("Orden inexistente.");
  if (a.rows[0].unit_id !== unitId) throw forbidden("Esta orden no es de tu unidad.");

  const res = await deps.transitionAssignment(c, {
    assignmentId,
    action: body.action,
    actor: { type: "unit", id: userId, unitId },
    expectedVersion: body.expectedVersion,
    reason: body.reason,
  });
  await appendEvent(c, {
    entityType: "assignment",
    entityId: assignmentId,
    kind: "unit_action",
    actorType: "unit",
    actorId: userId,
    data: { unit_id: unitId, idempotency_key: body.idempotencyKey, action: body.action, result: { status: res.status, version: res.version } },
  });
  return { assignmentId, status: res.status, version: res.version, replayed: false };
}

/** Despacho no disponible todavía (Operación no publicó `transitionAssignment`). */
export const dispatchUnavailable = () =>
  new DomainError("dispatch_unavailable", 503, "Las acciones sobre órdenes todavía no están disponibles.");
