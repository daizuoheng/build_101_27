import { z } from "zod";

// Contrato del planificador (Tarea 11). `buildPlan` lo implementa Operación en src/server/planning/build-plan.ts;
// Núcleo arma el snapshot desde la base (job `plan`) y persiste plan_runs/plan_items.

export const PRIORITY_BANDS = ["high", "medium", "low", "unknown"] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

export const DISPATCH_STRATEGIES = ["nearest_mobile", "zone_owner", "manual"] as const;
export type DispatchStrategy = (typeof DISPATCH_STRATEGIES)[number];

/** Motivos estables por los que un incidente no recibe propuesta. La UI los traduce; el LLM los explica. */
export const PENDING_REASONS = [
  "active_assignment", // ya tiene una orden activa (consume capacidad, no se reenvía)
  "dispatch_blocked", // revisión abierta sobre el incidente
  "manual_strategy", // la política del tipo exige asignación manual
  "no_location", // incidente sin ubicación utilizable
  "no_capable_unit", // ninguna unidad del territorio tiene las capacidades requeridas
  "no_capacity", // hay unidades capaces pero sin capacidad libre
  "stale_position", // unidades móviles capaces con posición vencida
  "out_of_radius", // unidades móviles capaces fuera de distancia/radio
  "no_zone_owner", // estrategia de zona sin responsable para área y tipo
  "ambiguous_zone_owner", // varios responsables con igual precedencia
] as const;
export type PendingReason = (typeof PENDING_REASONS)[number];

/** Motivos de selección de una propuesta. */
export const PROPOSAL_REASONS = ["nearest_mobile", "zone_owner", "preserves_scarce_unit", "only_capable_unit", "lowest_load"] as const;
export type ProposalReason = (typeof PROPOSAL_REASONS)[number];

export type PlanIncident = {
  id: string;
  revision: number;
  band: PriorityBand;
  activeHazard: boolean;
  createdAt: Date;
  /** Fuentes distintas estimadas dentro de la ventana; el backend ya deduplicó sesiones y evidencia repetida. */
  sourcesInWindow: number;
  dispatchBlocked: boolean;
  problemTypeId: string | null;
  /** Capacidades requeridas efectivas (incluye las de condición `active_hazard` si corresponde). */
  requiredCapabilities: string[];
  location: { lon: number; lat: number } | null;
  areaId: string | null;
};

export type PlanUnit = {
  id: string;
  kind: string;
  capabilities: string[];
  capacity: number;
  /** Órdenes activas (offered/accepted/in_progress) al momento del snapshot. */
  activeOrders: number;
  location: { lon: number; lat: number } | null;
  locationUpdatedAt: Date | null;
  serviceRadiusM: number | null;
  zoneResponsibilities: { areaId: string; problemTypeId: string; precedence: number }[];
};

export type PlanSnapshot = {
  territoryId: string;
  incidents: PlanIncident[];
  /** Solo unidades habilitadas del territorio. */
  units: PlanUnit[];
  activeAssignments: { incidentId: string; unitId: string }[];
  /** Estrategia por problemTypeId; los tipos ausentes usan `defaultStrategy`. */
  strategies: Record<string, DispatchStrategy>;
  defaultStrategy: DispatchStrategy;
};

/** Parámetros de las políticas `planning` y `dispatch` que usa el planificador (mismos nombres que en la base). */
export type PlanPolicy = {
  window_hours: number;
  weight_hours: number;
  cap_hours: number;
  max_distance_m: number;
  position_max_age_min: number;
};

export type ScoreBreakdown = {
  waitHours: number;
  sources: number;
  /** min(cap_hours, weight_hours × log2(max(1, sources))) */
  bonusHours: number;
  /** waitHours + bonusHours */
  score: number;
};

export type PlanProposal = { incidentId: string; unitId: string; distanceM: number | null; reasons: ProposalReason[] };

export type PlanQueueItem = {
  incidentId: string;
  /** 1-based, orden lexicográfico: activeHazard desc, banda, score desc, createdAt asc, id asc. */
  position: number;
  band: PriorityBand;
  activeHazard: boolean;
  score: ScoreBreakdown;
  proposal: PlanProposal | null;
  pendingReasons: PendingReason[];
};

export type BuildPlanResult = { queue: PlanQueueItem[]; proposals: PlanProposal[]; pending: { incidentId: string; reasons: PendingReason[] }[] };

/** Pura y determinista: mismo snapshot, política e instante ⇒ mismo resultado. Sin IO, sin IA. */
export type BuildPlan = (snapshot: PlanSnapshot, policy: PlanPolicy, now: Date) => BuildPlanResult;

// --- HTTP: GET /api/operacion/plan?territory=<slug> y POST /api/operacion/plan (recalcular) ---

export const PlanItemView = z.object({
  position: z.number(),
  incident: z.object({
    id: z.string(),
    title: z.string(),
    problemType: z.string().nullable(),
    areaName: z.string().nullable(),
    priorityBand: z.enum(PRIORITY_BANDS),
    activeHazard: z.boolean(),
    status: z.string(),
  }),
  score: z.object({ waitHours: z.number(), sources: z.number(), bonusHours: z.number(), score: z.number() }),
  proposedUnit: z.object({ id: z.string(), name: z.string() }).nullable(),
  assignedUnit: z.object({ id: z.string(), name: z.string(), status: z.string() }).nullable(),
  status: z.enum(["proposed", "executed", "obsolete", "blocked", "queued"]),
  reasons: z.array(z.string()),
  blockedReason: z.string().nullable(),
  explanation: z.string().nullable(),
});
export type PlanItemView = z.infer<typeof PlanItemView>;

export const PlanResponse = z.object({
  planRun: z.object({ id: z.string(), computedAt: z.string(), policyVersion: z.number(), trigger: z.string() }).nullable(),
  items: z.array(PlanItemView),
});
export type PlanResponse = z.infer<typeof PlanResponse>;
