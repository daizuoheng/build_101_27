import { z } from "zod";

// Contrato de /api/operacion/incidents (lista del operador).

export const IncidentListItem = z.object({
  id: z.string(),
  title: z.string(),
  problemType: z.object({ slug: z.string(), name: z.string() }).nullable(),
  severity: z.enum(["low", "medium", "high", "undetermined"]),
  activeHazard: z.boolean(),
  priorityBand: z.enum(["high", "medium", "low", "unknown"]),
  status: z.enum(["open", "assigned", "in_progress", "resolved", "archived"]),
  dispatchBlocked: z.boolean(),
  openReviewKinds: z.array(z.string()),
  area: z.object({ id: z.string(), name: z.string() }).nullable(),
  locationText: z.string().nullable(),
  lon: z.number(),
  lat: z.number(),
  reportCount: z.number(),
  sourceCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IncidentListItem = z.infer<typeof IncidentListItem>;

export const IncidentListQuery = z.object({
  territory: z.string(),
  areaId: z.string().uuid().optional(),
  problemType: z.string().optional(),
  priorityBand: z.enum(["high", "medium", "low", "unknown"]).optional(),
  status: z.enum(["open", "assigned", "in_progress", "resolved", "archived"]).optional(),
  sort: z.enum(["priority", "recent", "reports"]).default("priority"),
  /** Inicio de hoy y de ayer en el calendario local del operador (con DST un día no siempre dura 24 h). Piden `summary`. */
  dayStart: z.string().datetime({ offset: true }).optional(),
  yesterdayStart: z.string().datetime({ offset: true }).optional(),
});

// --- Correcciones del operador (overrides por campo). Dominio en Núcleo (src/server/incidents/overrides.ts). ---

export const OVERRIDE_FIELDS = ["problem_type_id", "severity", "priority_band", "location", "status"] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

/** Valor por campo: tipo por id del catálogo; ubicación como punto; estado solo para resolver/archivar a mano. */
export const OverrideValue = z.discriminatedUnion("field", [
  z.object({ field: z.literal("problem_type_id"), value: z.string().uuid() }),
  z.object({ field: z.literal("severity"), value: z.enum(["low", "medium", "high"]) }),
  z.object({ field: z.literal("priority_band"), value: z.enum(["high", "medium", "low"]) }),
  z.object({ field: z.literal("location"), value: z.object({ lon: z.number(), lat: z.number(), text: z.string().max(300).optional() }) }),
  z.object({ field: z.literal("status"), value: z.enum(["resolved", "archived"]) }),
]);
export type OverrideValue = z.infer<typeof OverrideValue>;

// POST /api/operacion/incidents/[id]/overrides  ·  DELETE /api/operacion/incidents/[id]/overrides/[field]
export const SetOverrideBody = z.object({
  override: OverrideValue,
  reason: z.string().trim().min(3).max(500),
  /** `incidents.revision` que vio el operador; si cambió ⇒ 409. */
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(64),
});
export type SetOverrideBody = z.infer<typeof SetOverrideBody>;

// POST /api/operacion/incidents/[id]/links  (asociar/desasociar reportes; dominio en Núcleo, src/server/incidents/links.ts)
export const LinkBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), reportId: z.string().uuid(), idempotencyKey: z.string().min(8).max(64) }),
  z.object({ action: z.literal("unlink"), reportId: z.string().uuid(), reason: z.string().trim().min(3).max(500), idempotencyKey: z.string().min(8).max(64) }),
]);
export type LinkBody = z.infer<typeof LinkBody>;

export const IncidentListResponse = z.object({
  territory: z.object({ slug: z.string(), name: z.string(), areaLabel: z.string(), center: z.object({ lon: z.number(), lat: z.number() }), zoom: z.number() }),
  filters: z.object({
    areas: z.array(z.object({ id: z.string(), name: z.string() })),
    problemTypes: z.array(z.object({ slug: z.string(), name: z.string() })),
  }),
  incidents: z.array(IncidentListItem),
  /**
   * Contadores del encabezado sobre todo el territorio: no dependen de los filtros ni del límite de la lista.
   * Solo si se pidieron con `dayStart` y `yesterdayStart`; si no, null.
   */
  summary: z
    .object({ active: z.number(), activeHigh: z.number(), review: z.number(), resolvedToday: z.number(), resolvedYesterday: z.number() })
    .nullable(),
  generatedAt: z.string(),
});
export type IncidentListResponse = z.infer<typeof IncidentListResponse>;
