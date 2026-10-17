// Firmas de los servicios de dominio que cruzan módulos. Cada módulo implementa las suyas en la ruta indicada,
// con exactamente esta firma; los demás importan desde esa ruta. Cambiar una firma = PR a main con aviso al equipo.
//
// Reglas comunes:
// - Las mutaciones reciben un PoolClient dentro de una transacción del llamador, salvo que se indique `Pool`.
// - Identidad y permisos vienen de la sesión del servidor (actor), nunca del cliente ni de un modelo.
// - Toda mutación registra `events` y encola solo las etapas afectadas (jobs idempotentes por revisión).
// - Errores esperables: DomainError de src/server/errors.ts (403, 404, 409 conflicto de versión, 400).

import type { Pool, PoolClient } from "pg";
import type { AssignmentAction } from "@/shared/contracts/assignment";
import type { OverrideValue, OverrideField } from "@/shared/contracts/incident";
import type { ResolveAction } from "@/shared/contracts/review";

export type Actor = { type: "system" | "operator" | "unit"; id: string | null; unitId?: string | null };

// ---------- Operación ----------

/** src/server/planning/build-plan.ts — pura (tipo en @/shared/contracts/plan). */
export type { BuildPlan } from "@/shared/contracts/plan";

/**
 * src/server/dispatch/apply-plan.ts — convierte las propuestas de un plan_run en órdenes, en orden de prioridad,
 * cada una en su transacción con FOR UPDATE de incidente y unidad. Si una revisión cambió, se detiene y encola `plan`.
 */
export type ApplyPlan = (pool: Pool, planRunId: string) => Promise<{ created: string[]; skipped: { incidentId: string; reason: string }[]; stoppedForReplan: boolean }>;

/**
 * src/server/dispatch/transitions.ts — transición de una orden según ASSIGNMENT_TRANSITIONS.
 * complete ⇒ incidente resolved; reject/cancel ⇒ incidente open + dispatch_blocked + review_items(rejected_assignment).
 * Toda transición encola `plan`.
 */
export type TransitionAssignment = (
  c: PoolClient,
  input: { assignmentId: string; action: AssignmentAction; actor: Actor; expectedVersion: number; reason?: string },
) => Promise<{ assignmentId: string; status: string; version: number }>;

/**
 * src/server/review/resolve.ts — aplica la acción con los servicios de cada módulo y cierra el ítem.
 * Al cerrar, recalcula `incidents.dispatch_blocked` de cada incidente afectado: queda en true solo si sigue
 * habiendo un ítem abierto sobre ese incidente, o un `uncertain_duplicate` abierto (sobre un reporte) que lo
 * lista en `evidence_refs[].candidate_incident_ids`. La agrupación bloquea así a los candidatos mientras se decide.
 */
export type ResolveReviewItem = (
  c: PoolClient,
  input: { reviewItemId: string; actor: Actor; resolution: ResolveAction; note?: string },
) => Promise<{ reviewItemId: string; status: "resolved" | "dismissed" }>;

// ---------- Núcleo ----------

/** src/server/review/items.ts — ya implementado. Idempotente por (kind, entidad) abierta; sobre incidente bloquea despacho. */
export type OpenReviewItem = typeof import("./review/items").openReviewItem;

/**
 * src/server/incidents/overrides.ts — corrección humana por campo. Sobrevive a reevaluaciones; encola assess_incident.
 * Si hay orden activa y cambia tipo/ubicación ⇒ assignments.review_blocked + review_items(incompatible_assignment).
 */
export type SetOverride = (
  c: PoolClient,
  input: { incidentId: string; override: OverrideValue; reason: string; actor: Actor; expectedRevision: number },
) => Promise<{ incidentId: string; revision: number }>;
export type RemoveOverride = (c: PoolClient, input: { incidentId: string; field: OverrideField; actor: Actor }) => Promise<{ incidentId: string; revision: number }>;

/** src/server/incidents/links.ts — vínculo reporte↔incidente (un activo por reporte). Reevalúa los incidentes afectados. */
export type LinkReport = (
  c: PoolClient,
  input: { reportId: string; incidentId: string; origin: "auto" | "manual"; groupingDecisionId?: string | null; actor: Actor },
) => Promise<{ linkId: string }>;
/** Desasociar el último reporte archiva el incidente y cancela su orden activa en la misma transacción. */
export type UnlinkReport = (c: PoolClient, input: { reportId: string; reason: string; actor: Actor }) => Promise<{ incidentId: string; archived: boolean }>;

/** src/server/pipeline/plan.ts — arma el snapshot desde la base, llama a buildPlan, persiste y encola dispatch. */
export type RunPlan = (pool: Pool, input: { territoryId: string; trigger: string }) => Promise<{ planRunId: string }>;
