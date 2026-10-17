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
});

export const GroupingPolicy = z.object({
  radius_m: z.number().positive(),
  max_candidates: z.number().int().positive(),
  same_threshold: z.number(),
  different_threshold: z.number(),
  conflict_band: z.number(),
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
});

export const DispatchPolicy = z.object({
  min_applicability: z.number(),
  min_type_confidence: z.number(),
  max_distance_m: z.number().positive(),
  position_max_age_min: z.number().positive(),
  default_strategy: z.enum(["nearest_mobile", "zone_owner", "manual"]),
  strategies: z.record(z.string(), z.enum(["nearest_mobile", "zone_owner", "manual"])),
});

export const TextgenPolicy = LlmCallConfig.extend({ enabled: z.boolean() });

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

/** Política activa validada. Falla si no existe o no valida: la app no inventa valores por defecto. */
export async function getActivePolicy<K extends PolicyKind>(db: Db, territoryId: string, kind: K): Promise<Versioned<PolicyOf<K>>> {
  const { rows } = await db.query<{ id: string; version: number; config: unknown }>(
    "select id, version, config from policy_versions where territory_id = $1 and kind = $2 and active",
    [territoryId, kind],
  );
  if (!rows[0]) throw new PolicyMissingError(territoryId, kind);
  const config = schemas[kind].parse(rows[0].config) as PolicyOf<K>;
  return { id: rows[0].id, version: rows[0].version, config };
}
