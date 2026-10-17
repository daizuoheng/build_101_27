import { z } from "zod";
import { PRIORITY_BANDS } from "./plan";

// Contrato de órdenes (Tarea 12). Dominio en src/server/dispatch (Operación); bandeja /unidad (Recepción).

export const ASSIGNMENT_STATUSES = ["offered", "accepted", "in_progress", "completed", "rejected", "cancelled"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const ACTIVE_ASSIGNMENT_STATUSES = ["offered", "accepted", "in_progress"] as const satisfies readonly AssignmentStatus[];

export const ASSIGNMENT_ACTIONS = ["accept", "reject", "start", "complete", "cancel"] as const;
export type AssignmentAction = (typeof ASSIGNMENT_ACTIONS)[number];

/**
 * Máquina de estados: desde qué estados se permite cada acción, el estado resultante y quién puede ejecutarla.
 * `transitionAssignment` y la UI la usan para mostrar solo botones válidos.
 */
export const ASSIGNMENT_TRANSITIONS: Record<AssignmentAction, { from: readonly AssignmentStatus[]; to: AssignmentStatus; actors: readonly ("unit" | "operator")[] }> = {
  accept: { from: ["offered"], to: "accepted", actors: ["unit"] },
  reject: { from: ["offered", "accepted"], to: "rejected", actors: ["unit"] },
  start: { from: ["accepted"], to: "in_progress", actors: ["unit"] },
  complete: { from: ["in_progress"], to: "completed", actors: ["unit", "operator"] },
  cancel: { from: ["offered", "accepted", "in_progress"], to: "cancelled", actors: ["operator"] },
};

/** Acciones disponibles para un actor; `review_blocked` impide iniciar y completar. */
export function allowedActions(status: AssignmentStatus, actor: "unit" | "operator", reviewBlocked: boolean): AssignmentAction[] {
  return ASSIGNMENT_ACTIONS.filter((a) => {
    const t = ASSIGNMENT_TRANSITIONS[a];
    if (!t.from.includes(status) || !t.actors.includes(actor)) return false;
    return !(reviewBlocked && (a === "start" || a === "complete"));
  });
}

// --- HTTP: POST /api/unidad/assignments/[id] y POST /api/operacion/assignments/[id] ---

export const TransitionBody = z.object({
  action: z.enum(ASSIGNMENT_ACTIONS),
  /** `assignments.version` que vio el cliente; si cambió ⇒ 409 y la UI refresca. */
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(64),
  reason: z.string().max(500).optional(),
});
export type TransitionBody = z.infer<typeof TransitionBody>;

// --- HTTP: GET /api/unidad/assignments (bandeja de la unidad autenticada) ---

export const UnitAssignmentCard = z.object({
  id: z.string(),
  status: z.enum(ASSIGNMENT_STATUSES),
  version: z.number(),
  reviewBlocked: z.boolean(),
  allowedActions: z.array(z.enum(ASSIGNMENT_ACTIONS)),
  distanceM: z.number().nullable(),
  /** Motivos de selección (códigos de PROPOSAL_REASONS). */
  reasons: z.array(z.string()),
  offeredAt: z.string(),
  acceptedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  incident: z.object({
    id: z.string(),
    title: z.string(),
    problemType: z.string().nullable(),
    priorityBand: z.enum(PRIORITY_BANDS),
    priorityRules: z.array(z.string()),
    activeHazard: z.boolean(),
    locationText: z.string().nullable(),
    areaName: z.string().nullable(),
    lon: z.number(),
    lat: z.number(),
    /** Textos originales de los ciudadanos (evidencia), nunca paráfrasis del LLM. */
    citizenTexts: z.array(z.string()),
    /** Fotos: GET /api/files/[attachmentId] (autorizado por sesión interna). */
    photoIds: z.array(z.string()),
    summary: z.string().nullable(),
  }),
});
export type UnitAssignmentCard = z.infer<typeof UnitAssignmentCard>;

export const UnitInboxResponse = z.object({
  unit: z.object({ id: z.string(), name: z.string(), kind: z.string(), capacity: z.number(), activeOrders: z.number() }),
  assignments: z.array(UnitAssignmentCard),
  generatedAt: z.string(),
});
export type UnitInboxResponse = z.infer<typeof UnitInboxResponse>;
