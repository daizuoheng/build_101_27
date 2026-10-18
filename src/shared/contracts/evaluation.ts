import { z } from "zod";

export const INTENTS = ["report", "status_query", "other"] as const;
export const APPLICABILITY = ["applicable", "unrelated", "insufficient"] as const;
export const SEVERITIES = ["low", "medium", "high", "undetermined"] as const;
export const ACTIVE_FIRE = ["yes", "no", "undeterminable"] as const;
export const PASSAGE = ["total", "partial", "none", "undetermined"] as const;
export const ACCESSIBILITY = ["affected", "partial", "not_affected", "undetermined"] as const;
export const LOCATION_IN_TEXT = ["precise", "vague", "absent"] as const;
export const PHOTO_QUALITY = ["useful", "insufficient", "no_photo"] as const;
export const CONSISTENCY = ["consistent", "contradiction", "not_evaluable"] as const;

/** Opciones estructurales de cada pregunta Choice. Las descripciones (criterios) vienen de la política. */
export const CHOICE_LABELS = {
  intent: INTENTS,
  applicability: APPLICABILITY,
  severity: SEVERITIES,
  active_fire: ACTIVE_FIRE,
  passage: PASSAGE,
  accessibility: ACCESSIBILITY,
  location_in_text: LOCATION_IN_TEXT,
  photo_quality: PHOTO_QUALITY,
  text_photo_consistency: CONSISTENCY,
} as const;

export const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});
export const NoulAnswerSchema = z.object({ type: z.literal("noul"), noul: z.number() });
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;

export const REVIEW_REASONS = ["insufficient_evidence", "contradiction", "low_confidence", "unknown_type"] as const;

export const ReportEvaluationSchema = z.object({
  intent: z.enum(INTENTS),
  applicability: z.enum(APPLICABILITY),
  problemTypeChoice: z.string(),
  problemTypeId: z.string().uuid().nullable(),
  severity: z.enum(SEVERITIES),
  activeFire: z.enum(ACTIVE_FIRE),
  passage: z.enum(PASSAGE),
  accessibility: z.enum(ACCESSIBILITY),
  locationInText: z.enum(LOCATION_IN_TEXT),
  photoQuality: z.enum(PHOTO_QUALITY),
  contradiction: z.enum(CONSISTENCY),
  answers: z.record(z.string(), z.union([ChoiceAnswerSchema, NoulAnswerSchema])),
  needsReview: z.boolean(),
  reviewReasons: z.array(z.enum(REVIEW_REASONS)),
  model: z.string(),
});
export type ReportEvaluation = z.infer<typeof ReportEvaluationSchema>;

export type AiError = { kind: "timeout" | "provider" | "invalid" | "config"; message: string };
export type AiResult<T> = { ok: true; value: T; aiRunId: string } | { ok: false; error: AiError; aiRunId?: string };
