import { z } from "zod";
import type { Db } from "../db/pool";

const LlmCallConfig = z.object({
  model: z.string(),
  instructions_version: z.string(),
  max_output_tokens: z.number().int().positive(),
  timeout_ms: z.number().int().positive(),
  extra_body: z.record(z.string(), z.unknown()).default({}),
});

const ChoiceSpec = z.object({ instructions: z.string(), criteria: z.record(z.string(), z.string()) });

export const IntakePolicy = z.object({
  jev_timeout_ms: z.number().int().positive(),
  max_clarification_rounds: z.number().int().min(0),
  require_photo: z.boolean(),
  thresholds: z.record(z.string(), z.number()),
  photo: z.object({ max_bytes: z.number().int().positive(), accepted_types: z.array(z.string()) }),
  geocoder: z.object({
    provider: z.literal("nominatim"),
    base_url: z.string().url(),
    country_codes: z.string(),
    query_suffix: z.string(),
    min_interval_ms: z.number().int().nonnegative(),
    timeout_ms: z.number().int().positive(),
  }),
  llm: LlmCallConfig,
  /**
   * Respuestas cortas que confirman o rechazan una pregunta del asistente sin botones (canales de solo texto).
   * Opcional: sin léxico, los botones de la web siguen funcionando y el texto va al flujo normal.
   */
  replies: z.object({ yes: z.array(z.string()), no: z.array(z.string()), send: z.array(z.string()) }).optional(),
  /** Consulta de estado por código: tope de consultas por sesión y hora (evita probar códigos al azar). */
  status_lookup: z.object({ max_per_hour: z.number().int().positive() }).optional(),
});

export const EvaluationPolicy = z.object({
  provider: z.literal("jev"),
  model: z.string(),
  image_header: z.boolean(),
  timeout_ms: z.number().int().positive(),
  questions: z.object({
    intent: ChoiceSpec,
    applicability: ChoiceSpec,
    severity: ChoiceSpec,
    active_fire: ChoiceSpec,
    passage: ChoiceSpec,
    accessibility: ChoiceSpec,
    location_in_text: ChoiceSpec,
    photo_quality: ChoiceSpec,
    text_photo_consistency: ChoiceSpec,
    problem_type: z.object({ instructions: z.string(), other: z.string(), unknown: z.string() }),
  }),
  noul_facts: z.array(z.object({ key: z.string().regex(/^[a-z_]+$/), instructions: z.string() })),
  review: z.object({ min_applicability: z.number(), min_type: z.number(), min_contradiction: z.number() }),
  assessment: z.object({
    timeout_ms: z.number().int().positive(),
    max_reports: z.number().int().positive(),
    max_photos: z.number().int().nonnegative(),
    preamble: z.string(),
    evolution: ChoiceSpec,
    consistency: ChoiceSpec,
    min_change: z.number().min(0).max(1),
    min_hazard_off: z.number().min(0).max(1),
    min_contradiction: z.number().min(0).max(1),
  }),
});

/** Texto de pregunta por candidato: `{candidate}` se reemplaza por el índice local (c1, c2…), nunca por un id. */
const PerCandidate = z.string().refine((s) => s.includes("{candidate}"), "debe incluir {candidate}");

export const GroupingPolicy = z.object({
  provider: z.literal("jev"),
  model: z.string(),
  image_header: z.boolean(),
  timeout_ms: z.number().int().positive(),
  radius_m: z.number().positive(),
  max_candidates: z.number().int().positive(),
  same_threshold: z.number(),
  different_threshold: z.number(),
  conflict_band: z.number(),
  evidence: z.object({
    max_reports_per_candidate: z.number().int().positive(),
    max_photos_per_candidate: z.number().int().nonnegative(),
  }),
  questions: z.object({
    match: z.object({
      instructions: PerCandidate,
      criteria: z.object({ same_incident: z.string(), different_incident: z.string(), uncertain: z.string() }),
    }),
    object_conflict: z.object({ instructions: PerCandidate }),
    place_conflict: z.object({ instructions: PerCandidate }),
    time_conflict: z.object({ instructions: PerCandidate }),
  }),
});

export const PriorityPolicy = z.object({
  high: z.object({
    severity: z.array(z.string()),
    active_hazard: z.boolean(),
    passage: z.array(z.string()),
    accessibility: z.array(z.string()),
  }),
  medium: z.object({ severity: z.array(z.string()) }),
  promote_low_to_medium_after_hours: z.number().positive(),
});

export const PlanningPolicy = z.object({
  window_hours: z.number().positive(),
  weight_hours: z.number().nonnegative(),
  cap_hours: z.number().nonnegative(),
  replan_interval_min: z.number().positive(),
  /** Si otra corrida de plan del territorio está en curso, el pedido se reintenta en un job único a estos segundos. */
  busy_retry_sec: z.number().int().positive(),
});

export const DispatchPolicy = z.object({
  min_applicability: z.number(),
  min_type_confidence: z.number(),
  max_distance_m: z.number().positive(),
  position_max_age_min: z.number().positive(),
  default_strategy: z.enum(["nearest_mobile", "zone_owner", "manual"]),
  strategies: z.record(z.string(), z.enum(["nearest_mobile", "zone_owner", "manual"])),
});

const TextPurposes = z.object({ title: z.string(), summary: z.string(), explain_priority: z.string() });
/** Se compila una vez al leer la política (flags "iu": sin mayúsculas y con clases Unicode). */
const Regex = z.string().transform((src, ctx) => {
  try {
    return new RegExp(src, "iu");
  } catch {
    ctx.addIssue({ code: "custom", message: "expresión regular inválida" });
    return z.NEVER;
  }
});

export const TextgenPolicy = LlmCallConfig.extend({
  enabled: z.boolean(),
  /**
   * Propósitos que redacta el LLM; el resto sale de su plantilla determinista. Vacío = todo determinista, y es el
   * valor si falta: así una política publicada antes de este campo sigue validando y conserva sus ajustes.
   */
  llm_purposes: z.array(z.enum(["title", "summary", "explain_priority"])).default([]),
  max_chars: z.object({ title: z.number().int().positive(), summary: z.number().int().positive(), explain_priority: z.number().int().positive() }),
  max_references: z.number().int().positive(),
  max_reference_chars: z.number().int().positive(),
  forbidden_patterns: z.array(Regex),
  instructions: TextPurposes.extend({ common: z.string(), untrusted: z.string(), output: z.string().refine((s) => /json/i.test(s), "debe mencionar json") }),
  labels: z.object({
    unknown_type: z.string(),
    unknown_place: z.string(),
    list_separator: z.string(),
    no_reasons: z.string(),
    redacted: z.string(),
    unexplained_band: z.string(),
    severity: z.record(z.string(), z.string()),
    passage: z.record(z.string(), z.string()),
    accessibility: z.record(z.string(), z.string()),
    active_hazard: z.record(z.string(), z.string()),
    priority_band: z.record(z.string(), z.string()),
    priority_rule: z.record(z.string(), z.string()),
  }),
});

const schemas = {
  intake: IntakePolicy,
  evaluation: EvaluationPolicy,
  grouping: GroupingPolicy,
  priority: PriorityPolicy,
  planning: PlanningPolicy,
  dispatch: DispatchPolicy,
  textgen: TextgenPolicy,
};

export type PolicyKind = keyof typeof schemas;
export type PolicyOf<K extends PolicyKind> = z.infer<(typeof schemas)[K]>;
export type Versioned<T> = { id: string; version: number; config: T };

export type IntakePolicy = z.infer<typeof IntakePolicy>;
export type EvaluationPolicy = z.infer<typeof EvaluationPolicy>;
export type GroupingPolicy = z.infer<typeof GroupingPolicy>;
export type PriorityPolicy = z.infer<typeof PriorityPolicy>;
export type PlanningPolicy = z.infer<typeof PlanningPolicy>;
export type DispatchPolicy = z.infer<typeof DispatchPolicy>;
export type TextgenPolicy = z.infer<typeof TextgenPolicy>;

export class PolicyMissingError extends Error {
  constructor(public territoryId: string, public kind: PolicyKind) {
    super(`no hay política activa '${kind}' para el territorio ${territoryId}`);
  }
}

export class PolicyInvalidError extends Error {
  constructor(public territoryId: string, public kind: PolicyKind, public version: number, detail: string) {
    super(`la política activa '${kind}' v${version} del territorio ${territoryId} no valida contra el esquema actual (${detail}). Correr \`pnpm cli seed\` publica la del seed como versión nueva`);
  }
}

/** ¿La configuración valida contra el esquema actual de su tipo? */
export function isValidPolicy(kind: PolicyKind, config: unknown): boolean {
  return schemas[kind].safeParse(config).success;
}

/** Política activa validada. Falla si no existe o no valida: la app no inventa valores por defecto. */
export async function getActivePolicy<K extends PolicyKind>(db: Db, territoryId: string, kind: K): Promise<Versioned<PolicyOf<K>>> {
  const { rows } = await db.query<{ id: string; version: number; config: unknown }>(
    "select id, version, config from policy_versions where territory_id = $1 and kind = $2 and active",
    [territoryId, kind],
  );
  if (!rows[0]) throw new PolicyMissingError(territoryId, kind);
  const parsed = schemas[kind].safeParse(rows[0].config);
  if (!parsed.success) throw new PolicyInvalidError(territoryId, kind, rows[0].version, parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  return { id: rows[0].id, version: rows[0].version, config: parsed.data as PolicyOf<K> };
}
