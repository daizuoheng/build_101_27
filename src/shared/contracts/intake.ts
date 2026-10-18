import { z } from "zod";

// Contrato HTTP de /api/reportar/*. Lo comparten las rutas y la UI ciudadana.

export const TerritoryView = z.object({
  slug: z.string(),
  name: z.string(),
  areaLabel: z.string(),
  center: z.object({ lon: z.number(), lat: z.number() }),
  zoom: z.number(),
  emergencyText: z.string().nullable(),
});
export type TerritoryView = z.infer<typeof TerritoryView>;

/** Acciones de UI que acompañan un mensaje del asistente. El cliente las muestra como botones o tarjetas. */
export const MessageUi = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ask_location") }),
  z.object({ kind: z.literal("propose_location"), lon: z.number(), lat: z.number(), label: z.string() }),
  z.object({ kind: z.literal("ask_evidence"), requestedField: z.enum(["photo", "description"]) }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("active_hazard") }),
  z.object({ kind: z.literal("confirmed"), publicCode: z.string() }),
]);
export type MessageUi = z.infer<typeof MessageUi>;

export const MessageView = z.object({
  id: z.string(),
  seq: z.number(),
  role: z.enum(["citizen", "assistant", "system"]),
  body: z.string(),
  origin: z.enum(["human", "template", "llm"]),
  createdAt: z.string(),
  ui: MessageUi.nullable(),
  attachmentId: z.string().nullable(),
});
export type MessageView = z.infer<typeof MessageView>;

export const DraftCard = z.object({
  typeName: z.string().nullable(),
  /** Relato del problema con las palabras de la persona (sin respuestas cortas, consultas ni direcciones sueltas). */
  description: z.string().nullable(),
  severity: z.enum(["low", "medium", "high", "undetermined"]).nullable(),
  place: z.string().nullable(),
  areaName: z.string().nullable(),
  photoCount: z.number(),
  activeHazard: z.boolean(),
  needsReview: z.boolean(),
  /** true cuando la evaluación vigente permite enviar (reporte + ubicación confirmada). */
  ready: z.boolean(),
  missing: z.array(z.enum(["description", "location", "evaluation"])),
});
export type DraftCard = z.infer<typeof DraftCard>;

export const DraftView = z.object({
  id: z.string(),
  status: z.enum(["draft", "confirmed"]),
  revision: z.number(),
  publicCode: z.string().nullable(),
  territory: TerritoryView,
  messages: z.array(MessageView),
  location: z
    .object({
      lon: z.number(),
      lat: z.number(),
      text: z.string().nullable(),
      source: z.enum(["gps", "map", "geocoded"]).nullable(),
      confirmed: z.boolean(),
      areaName: z.string().nullable(),
    })
    .nullable(),
  card: DraftCard,
  /** Hay una evaluación en curso en el worker: la UI hace polling. */
  analysisPending: z.boolean(),
  /** Estado posterior al envío, solo lectura desde la base. */
  tracking: z
    .object({
      processing: z.enum(["pending", "running", "done", "error"]),
      outcome: z.enum(["applicable", "unrelated", "insufficient", "out_of_coverage"]).nullable(),
      incidentStatus: z.enum(["open", "assigned", "in_progress", "resolved", "archived"]).nullable(),
      priorityBand: z.enum(["high", "medium", "low", "unknown"]).nullable(),
      statusLabel: z.string(),
    })
    .nullable(),
});
export type DraftView = z.infer<typeof DraftView>;

export const MyReportItem = z.object({
  id: z.string(),
  status: z.enum(["draft", "confirmed"]),
  publicCode: z.string().nullable(),
  createdAt: z.string(),
  preview: z.string().nullable(),
});

// Cuerpos de request
export const CreateDraftBody = z.object({ territorySlug: z.string().min(1) });
export const PostMessageBody = z.object({ clientMessageId: z.string().min(8).max(64), body: z.string().trim().min(1).max(2000) });
export const SetLocationBody = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  source: z.enum(["gps", "map", "geocoded"]),
  text: z.string().max(300).optional(),
});
export const ConfirmBody = z.object({ idempotencyKey: z.string().min(8).max(64) });
export const GeocodeResult = z.object({ lon: z.number(), lat: z.number(), label: z.string() }).nullable();

export type ApiError = { error: string; message: string };
