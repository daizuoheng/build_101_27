import { choice, image, noul, type ContentValue, type Questions } from "@typesafe-ai/sdk";
import type { EvaluationPolicy, Versioned } from "@/server/config/policies";
import type { CatalogType } from "@/server/config/catalog";
import type { AiRunRecord } from "@/server/ai/runs";
import {
  CHOICE_LABELS,
  ChoiceAnswerSchema,
  NoulAnswerSchema,
  type AiResult,
  type ChoiceAnswer,
  type ReportEvaluation,
} from "@/shared/contracts/evaluation";
import { toAiError, type JevClient } from "./client";
import { chosenProbability } from "./thresholds";

export type EvaluateReportInput = {
  reportId: string;
  reportRevision: number;
  messages: { id: string; body: string; createdAt: string }[];
  images: { attachmentId: string; bytes: Buffer; format: "jpeg" | "png" }[];
  location: { confirmed: boolean; text: string | null; areaName: string | null };
  catalog: CatalogType[];
  catalogHash: string;
  policy: Versioned<EvaluationPolicy>;
};

export type EvaluateReportDeps = { jev: JevClient; recordRun: (run: AiRunRecord) => Promise<string> };

const SPECIAL_TYPES = ["other", "unknown"] as const;

export function describeType(t: CatalogType): string {
  const c = (t.criteria ?? {}) as { is?: string; is_not?: string; examples?: string[] };
  return [t.name + ".", c.is, c.is_not ? `Not: ${c.is_not}` : null, c.examples?.length ? `Examples: ${c.examples.join("; ")}` : null]
    .filter(Boolean)
    .join(" ");
}

/** Preguntas de la evaluación: estructura del código, textos y criterios de la política y del catálogo activo. */
export function buildReportQuestions(policy: EvaluationPolicy, catalog: CatalogType[]): Questions {
  const q = policy.questions;
  const questions: Questions = {};
  for (const key of Object.keys(CHOICE_LABELS) as (keyof typeof CHOICE_LABELS)[]) {
    const spec = q[key];
    const criteria: Record<string, string> = {};
    for (const label of CHOICE_LABELS[key]) criteria[label] = spec.criteria[label] ?? label;
    questions[key] = choice(spec.instructions, criteria);
  }
  const typeCriteria: Record<string, string> = {};
  for (const t of catalog) typeCriteria[t.slug] = describeType(t);
  typeCriteria.other = q.problem_type.other;
  typeCriteria.unknown = q.problem_type.unknown;
  questions.problem_type = choice(q.problem_type.instructions, typeCriteria);
  for (const f of policy.noul_facts) questions[`fact_${f.key}`] = noul(f.instructions);
  return questions;
}

class InvalidAnswer extends Error {}

function choiceOf(answers: Record<string, unknown>, key: string, allowed: readonly string[]): ChoiceAnswer {
  const parsed = ChoiceAnswerSchema.safeParse(answers[key]);
  if (!parsed.success) throw new InvalidAnswer(`respuesta '${key}' ausente o con forma inválida`);
  if (!allowed.includes(parsed.data.choice)) throw new InvalidAnswer(`'${key}' devolvió una opción fuera del input: ${parsed.data.choice}`);
  return parsed.data;
}

/** Traduce la respuesta cruda de Jev al contrato interno. Pura: valida opciones contra el input permitido. */
export function mapReportAnswers(
  raw: Record<string, unknown>,
  catalog: CatalogType[],
  policy: EvaluationPolicy,
  model: string,
): ReportEvaluation {
  const a = {
    intent: choiceOf(raw, "intent", CHOICE_LABELS.intent),
    applicability: choiceOf(raw, "applicability", CHOICE_LABELS.applicability),
    severity: choiceOf(raw, "severity", CHOICE_LABELS.severity),
    active_fire: choiceOf(raw, "active_fire", CHOICE_LABELS.active_fire),
    passage: choiceOf(raw, "passage", CHOICE_LABELS.passage),
    accessibility: choiceOf(raw, "accessibility", CHOICE_LABELS.accessibility),
    location_in_text: choiceOf(raw, "location_in_text", CHOICE_LABELS.location_in_text),
    photo_quality: choiceOf(raw, "photo_quality", CHOICE_LABELS.photo_quality),
    text_photo_consistency: choiceOf(raw, "text_photo_consistency", CHOICE_LABELS.text_photo_consistency),
    problem_type: choiceOf(raw, "problem_type", [...catalog.map((t) => t.slug), ...SPECIAL_TYPES]),
  };
  const answers: ReportEvaluation["answers"] = { ...a };
  for (const f of policy.noul_facts) {
    const parsed = NoulAnswerSchema.safeParse(raw[`fact_${f.key}`]);
    if (!parsed.success) throw new InvalidAnswer(`respuesta 'fact_${f.key}' ausente o inválida`);
    answers[`fact_${f.key}`] = parsed.data;
  }

  const reasons = new Set<ReportEvaluation["reviewReasons"][number]>();
  const r = policy.review;
  if (a.intent.choice === "report") {
    if (a.applicability.choice === "insufficient") reasons.add("insufficient_evidence");
    if (a.applicability.choice === "applicable" && chosenProbability(a.applicability) < r.min_applicability) reasons.add("low_confidence");
    if (a.text_photo_consistency.choice === "contradiction" && chosenProbability(a.text_photo_consistency) >= r.min_contradiction)
      reasons.add("contradiction");
    if (a.applicability.choice === "applicable") {
      if ((SPECIAL_TYPES as readonly string[]).includes(a.problem_type.choice)) reasons.add("unknown_type");
      else if (chosenProbability(a.problem_type) < r.min_type) reasons.add("low_confidence");
    }
  }

  const type = catalog.find((t) => t.slug === a.problem_type.choice);
  return {
    intent: a.intent.choice as ReportEvaluation["intent"],
    applicability: a.applicability.choice as ReportEvaluation["applicability"],
    problemTypeChoice: a.problem_type.choice,
    problemTypeId: type?.id ?? null,
    severity: a.severity.choice as ReportEvaluation["severity"],
    activeFire: a.active_fire.choice as ReportEvaluation["activeFire"],
    passage: a.passage.choice as ReportEvaluation["passage"],
    accessibility: a.accessibility.choice as ReportEvaluation["accessibility"],
    locationInText: a.location_in_text.choice as ReportEvaluation["locationInText"],
    photoQuality: a.photo_quality.choice as ReportEvaluation["photoQuality"],
    contradiction: a.text_photo_consistency.choice as ReportEvaluation["contradiction"],
    answers,
    needsReview: reasons.size > 0,
    reviewReasons: [...reasons],
    model,
  };
}

/** Evalúa el estado completo del borrador/reporte con Jev. Registra la corrida (sin bytes) haya éxito o no. */
export async function evaluateReport(input: EvaluateReportInput, deps: EvaluateReportDeps): Promise<AiResult<ReportEvaluation>> {
  const policy = input.policy.config;
  const questions = buildReportQuestions(policy, input.catalog);
  const location: ContentValue = input.location.confirmed
    ? { confirmed: true, description: input.location.text, area: input.location.areaName }
    : { confirmed: false };
  const state: { [key: string]: ContentValue } = {
    report: {
      messages: input.messages.map((m) => ({ id: m.id, sent_at: m.createdAt, text: m.body })),
      photos: input.images.map((i) => ({ id: i.attachmentId, image: image(i.bytes) })),
      location,
    },
  };
  const withImages = input.images.length > 0 && policy.image_header;
  const inputRefs = {
    report_id: input.reportId,
    report_revision: input.reportRevision,
    message_ids: input.messages.map((m) => m.id),
    attachment_ids: input.images.map((i) => i.attachmentId),
    catalog_hash: input.catalogHash,
    policy_version_id: input.policy.id,
  };
  const base = { purpose: "evaluate" as const, provider: "jev", modelRequested: policy.model, inputRefs, request: { state, questions } };

  let res;
  try {
    res = await deps.jev.systemOne({ model: policy.model, state, questions, withImages, timeoutMs: policy.timeout_ms });
  } catch (err) {
    const error = toAiError(err);
    const aiRunId = await deps.recordRun({ ...base, status: error.kind === "timeout" ? "timeout" : "error", error: error.message });
    return { ok: false, error, aiRunId };
  }

  const record = { ...base, modelReturned: res.data.model, requestId: res.requestId, response: res.data.answers, usage: res.data.usage, latencyMs: res.latencyMs };
  try {
    const value = mapReportAnswers(res.data.answers as Record<string, unknown>, input.catalog, policy, res.data.model);
    const aiRunId = await deps.recordRun({ ...record, status: "ok" });
    return { ok: true, value, aiRunId };
  } catch (err) {
    if (!(err instanceof InvalidAnswer)) throw err;
    const aiRunId = await deps.recordRun({ ...record, status: "invalid", error: err.message });
    return { ok: false, error: { kind: "invalid", message: err.message }, aiRunId };
  }
}
