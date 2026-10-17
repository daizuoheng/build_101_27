import { z } from "zod";

// Contrato de la cola de revisión (Tarea 14). Dominio en src/server/review (Operación);
// `openReviewItem` ya existe y lo usan todos los módulos para abrir ítems.

export const REVIEW_KINDS = [
  "insufficient_evidence",
  "uncertain_duplicate",
  "contradiction",
  "low_confidence",
  "unknown_type",
  "no_compatible_unit",
  "rejected_assignment",
  "incompatible_assignment",
  "provider_failure",
  "out_of_coverage",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATUSES = ["open", "resolved", "dismissed"] as const;

/** Acciones de resolución. Cada una se aplica con los servicios de dominio de su módulo, nunca con updates sueltos. */
export const ResolveAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), incidentId: z.string().uuid() }), // uncertain_duplicate → asociar
  z.object({ action: z.literal("create_incident") }), // uncertain_duplicate / insufficient_evidence → incidente nuevo
  z.object({ action: z.literal("set_type"), problemTypeId: z.string().uuid() }), // override de tipo
  z.object({ action: z.literal("set_severity"), severity: z.enum(["low", "medium", "high"]) }), // override de severidad
  z.object({ action: z.literal("allow_dispatch") }), // evidencia aceptada: desbloquea despacho
  z.object({ action: z.literal("reassign"), unitId: z.string().uuid() }), // rejected/incompatible_assignment
  z.object({ action: z.literal("retry") }), // provider_failure → reencolar
  z.object({ action: z.literal("dismiss") }), // descartar (ruido, fuera de cobertura)
]);
export type ResolveAction = z.infer<typeof ResolveAction>;

// --- HTTP: POST /api/operacion/review/[id]/resolve ---

export const ResolveBody = z.object({
  resolution: ResolveAction,
  idempotencyKey: z.string().min(8).max(64),
  note: z.string().max(500).optional(),
});
export type ResolveBody = z.infer<typeof ResolveBody>;

// --- HTTP: GET /api/operacion/review?territory=<slug> ---

export const ReviewItemView = z.object({
  id: z.string(),
  kind: z.enum(REVIEW_KINDS),
  status: z.enum(REVIEW_STATUSES),
  entityType: z.enum(["report", "incident", "assignment"]),
  entityId: z.string(),
  reasons: z.array(z.record(z.string(), z.unknown())),
  evidenceRefs: z.array(z.record(z.string(), z.unknown())),
  createdAt: z.string(),
  /** Para ordenar la cola: banda del incidente afectado (o unknown) y antigüedad. */
  priorityBand: z.enum(["high", "medium", "low", "unknown"]),
  activeHazard: z.boolean(),
  title: z.string(),
  /** Acciones válidas para este kind. */
  actions: z.array(z.string()),
});
export type ReviewItemView = z.infer<typeof ReviewItemView>;

export const ReviewQueueResponse = z.object({ items: z.array(ReviewItemView), generatedAt: z.string() });
export type ReviewQueueResponse = z.infer<typeof ReviewQueueResponse>;
