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
});

export const IncidentListResponse = z.object({
  territory: z.object({ slug: z.string(), name: z.string(), areaLabel: z.string(), center: z.object({ lon: z.number(), lat: z.number() }), zoom: z.number() }),
  filters: z.object({
    areas: z.array(z.object({ id: z.string(), name: z.string() })),
    problemTypes: z.array(z.object({ slug: z.string(), name: z.string() })),
  }),
  incidents: z.array(IncidentListItem),
  generatedAt: z.string(),
});
export type IncidentListResponse = z.infer<typeof IncidentListResponse>;
