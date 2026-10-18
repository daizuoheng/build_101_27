import { z } from "zod";
import { ASSIGNMENT_STATUSES } from "./assignment";
import { ACCESSIBILITY } from "./evaluation";
import { IncidentListItem, OVERRIDE_FIELDS } from "./incident";
import { REVIEW_KINDS } from "./review";

// Contrato del detalle del incidente para el operador (Tarea 14). Dominio en src/server/incidents/detail.ts.

// --- HTTP: GET /api/operacion/incidents/[id] ---

export const IncidentDetailResponse = z.object({
  incident: IncidentListItem.extend({
    revision: z.number(),
    passage: z.enum(["total", "partial", "none", "undetermined"]),
    accessibility: z.enum(ACCESSIBILITY),
    /** `incidents.summary` (textgen); null si todavía no se generó. */
    summary: z.string().nullable(),
    /** Texto `explain_priority` de la revisión vigente; null si todavía no se generó. */
    explainPriority: z.string().nullable(),
    /** Códigos de `priority_breakdown.rules`, más `promoted_by_age` si la antigüedad subió la banda. */
    priorityRules: z.array(z.string()),
    /** Banda fijada por una corrección vigente del operador; null si la banda sale de las reglas. */
    bandOverride: z.enum(["high", "medium", "low"]).nullable(),
  }),
  /** Correcciones vigentes, de la más vieja a la más nueva. */
  overrides: z.array(z.object({ field: z.enum(OVERRIDE_FIELDS), value: z.unknown(), reason: z.string(), createdAt: z.string() })),
  /** Reportes vinculados (vínculo activo). */
  reports: z.array(
    z.object({
      id: z.string(),
      publicCode: z.string().nullable(),
      confirmedAt: z.string().nullable(),
      linkOrigin: z.enum(["auto", "manual"]),
      description: z.string().nullable(),
      /**
       * Relato del ciudadano (sin respuestas de control ni marcadores de foto). El enum son los roles de `messages.role`
       * (migrations/0002_intake.sql); hoy el detalle solo envía `citizen`: lo demás puede citar otros reportes de la sesión.
       */
      messages: z.array(z.object({ role: z.enum(["citizen", "assistant", "system"]), body: z.string(), createdAt: z.string() })),
      /** Adjuntos `original` del reporte; se sirven por GET /api/operacion/photos/[id] (derivado JPEG). */
      photoIds: z.array(z.string()),
    }),
  ),
  activeAssignment: z
    .object({ id: z.string(), status: z.enum(ASSIGNMENT_STATUSES), version: z.number(), unitName: z.string(), reviewBlocked: z.boolean(), offeredAt: z.string() })
    .nullable(),
  /** Ítems abiertos sobre el incidente, sus órdenes o sus reportes vinculados. */
  openReviewItems: z.array(z.object({ id: z.string(), kind: z.enum(REVIEW_KINDS), reasons: z.array(z.record(z.string(), z.unknown())), createdAt: z.string() })),
  /** Últimos 50 eventos del incidente, de sus reportes vinculados y de sus órdenes, del más nuevo al más viejo. */
  events: z.array(z.object({ kind: z.string(), actorType: z.string(), createdAt: z.string(), data: z.record(z.string(), z.unknown()) })),
  /** Tipos habilitados en el territorio, para corregir el tipo. */
  problemTypes: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
  generatedAt: z.string(),
});
export type IncidentDetailResponse = z.infer<typeof IncidentDetailResponse>;

// --- HTTP: DELETE /api/operacion/incidents/[id]/overrides/[field] ---

/** Quitar una corrección también es idempotente: un reintento con la misma clave devuelve lo mismo. */
export const RemoveOverrideBody = z.object({ idempotencyKey: z.string().min(8).max(64) });
export type RemoveOverrideBody = z.infer<typeof RemoveOverrideBody>;

/** Respuesta de POST …/overrides y DELETE …/overrides/[field]. */
export type OverrideResult = { incidentId: string; revision: number; replayed: boolean };

/** Respuesta de POST …/links. */
export type LinkResult =
  | { action: "link"; incidentId: string; reportId: string; previousIncidentId: string | null; replayed: boolean }
  | { action: "unlink"; incidentId: string; reportId: string; archived: boolean; replayed: boolean };
