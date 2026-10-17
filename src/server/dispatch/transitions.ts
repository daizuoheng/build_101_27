// Transiciones de órdenes (Tarea 12) según ASSIGNMENT_TRANSITIONS de @/shared/contracts/assignment.
// Identidad y unidad vienen del actor de la sesión del servidor; concurrencia optimista por `assignments.version`.

import type { TransitionAssignment } from "../contracts";
import { conflict, forbidden, notFound } from "../errors";
import { appendEvent } from "../events/append";
import { enqueue } from "../jobs/queue";
import { openReviewItem } from "../review/items";
import { ASSIGNMENT_TRANSITIONS, type AssignmentAction, type AssignmentStatus } from "@/shared/contracts/assignment";

/** Efecto sobre el incidente de cada transición. `accept` lo deja en `assigned`. */
const INCIDENT_EFFECT: Partial<Record<AssignmentAction, "in_progress" | "resolved" | "reopen">> = {
  start: "in_progress",
  complete: "resolved",
  reject: "reopen",
  cancel: "reopen",
};

const TIMESTAMP: Partial<Record<AssignmentStatus, string>> = { accepted: "accepted_at", in_progress: "started_at", completed: "completed_at" };

export const transitionAssignment: TransitionAssignment = async (c, input) => {
  // Mismo orden de bloqueo que el despacho (incidente → orden), para que applyPlan y una transición sobre el mismo
  // incidente no formen un ciclo. `incident_id` de una orden no cambia nunca, así que se puede leer sin bloquear.
  const ref = await c.query<{ incident_id: string }>("select incident_id from assignments where id = $1", [input.assignmentId]);
  if (!ref.rows[0]) throw notFound("Orden inexistente.");
  await c.query("select 1 from incidents where id = $1 for update", [ref.rows[0].incident_id]);

  const a = (
    await c.query<{ id: string; incident_id: string; unit_id: string; status: AssignmentStatus; version: number; review_blocked: boolean; territory_id: string }>(
      `select a.id, a.incident_id, a.unit_id, a.status, a.version, a.review_blocked, i.territory_id
       from assignments a join incidents i on i.id = a.incident_id where a.id = $1 for update of a`,
      [input.assignmentId],
    )
  ).rows[0];
  if (!a) throw notFound("Orden inexistente.");

  const rule = ASSIGNMENT_TRANSITIONS[input.action];
  const actorType = input.actor.type;
  if (actorType === "system" || !rule.actors.includes(actorType)) throw forbidden("No podés hacer esta acción sobre la orden.");
  if (actorType === "unit" && input.actor.unitId !== a.unit_id) throw forbidden("Esta orden no es de tu unidad.");
  if (a.version !== input.expectedVersion) throw conflict("version_conflict", "La orden cambió mientras la mirabas. Actualizá y probá de nuevo.");
  if (!rule.from.includes(a.status)) throw conflict("invalid_transition", "Esta acción no está disponible en el estado actual de la orden.");
  if (a.review_blocked && (input.action === "start" || input.action === "complete")) {
    throw conflict("review_blocked", "La orden está en revisión: no se puede iniciar ni completar hasta que operación la revise.");
  }

  const to = rule.to;
  const version = a.version + 1;
  const ts = TIMESTAMP[to];
  const closes = to === "rejected" || to === "cancelled" || to === "completed";
  await c.query(
    `update assignments set status = $2, version = $3, updated_at = now()${ts ? `, ${ts} = now()` : ""}${closes ? ", closed_reason = $4" : ""}
     where id = $1`,
    closes ? [a.id, to, version, input.reason ?? input.action] : [a.id, to, version],
  );

  const effect = INCIDENT_EFFECT[input.action];
  if (effect === "in_progress") {
    await c.query("update incidents set status = 'in_progress', updated_at = now() where id = $1", [a.incident_id]);
  } else if (effect === "resolved") {
    await c.query("update incidents set status = 'resolved', resolved_at = now(), updated_at = now() where id = $1", [a.incident_id]);
  } else if (effect === "reopen") {
    // Rechazo o cancelación: libera la unidad y devuelve el incidente a revisión manual, sin reenvío automático.
    // Solo reabre un incidente en atención: nunca resucita uno resuelto o archivado.
    await c.query("update incidents set status = 'open', updated_at = now() where id = $1 and status in ('assigned', 'in_progress')", [a.incident_id]);
    await openReviewItem(c, {
      territoryId: a.territory_id,
      kind: "rejected_assignment",
      entityType: "incident",
      entityId: a.incident_id,
      reasons: [{ code: input.action === "reject" ? "rejected_by_unit" : "cancelled_by_operator", assignment_id: a.id, unit_id: a.unit_id, reason: input.reason ?? null }],
      evidenceRefs: [{ assignment_id: a.id }],
    });
  }

  const actorId = input.actor.id;
  await appendEvent(c, {
    entityType: "assignment",
    entityId: a.id,
    kind: `assignment_${to}`,
    actorType,
    actorId,
    data: { action: input.action, from: a.status, to, version, reason: input.reason ?? null, unit_id: a.unit_id },
  });
  if (effect) {
    await appendEvent(c, {
      entityType: "incident",
      entityId: a.incident_id,
      kind: effect === "reopen" ? "reopened" : effect,
      actorType,
      actorId,
      data: { assignment_id: a.id, action: input.action },
    });
  }

  // Cambió la disponibilidad de la unidad o el estado del incidente: replanificar (idempotente por versión).
  await enqueue(c, {
    kind: "plan",
    entityType: "territory",
    entityId: a.territory_id,
    entityRevision: 0,
    territoryId: a.territory_id,
    payload: { trigger: `assignment_${to}`, assignment_id: a.id },
    dedupeSuffix: `assignment:${a.id}:${version}`,
  });

  return { assignmentId: a.id, status: to, version };
};
