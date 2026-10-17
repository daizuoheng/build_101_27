import { choice, image, type ContentValue, type Questions } from "@typesafe-ai/sdk";
import type { EvaluationPolicy, Versioned } from "@/server/config/policies";
import type { CatalogType } from "@/server/config/catalog";
import type { AiRunRecord } from "@/server/ai/runs";
import { CHOICE_LABELS, ChoiceAnswerSchema, type AiResult, type ChoiceAnswer } from "@/shared/contracts/evaluation";
import { toAiError, type JevClient } from "./client";
import { describeType } from "./evaluate-report";

export const EVOLUTION = ["worsened", "same", "improved", "undetermined"] as const;
export const REPORTS_CONSISTENCY = ["consistent", "contradiction", "not_evaluable"] as const;
const SPECIAL_TYPES = ["other", "unknown"] as const;

export type AssessReportEvidence = {
  reportId: string;
  confirmedAt: string;
  messages: { id: string; body: string }[];
  images: { attachmentId: string; bytes: Buffer }[];
};

export type AssessIncidentInput = {
  incidentId: string;
  incidentRevision: number;
  /** Valores efectivos vigentes (para contexto; Jev juzga con la evidencia). */
  current: { problemType: string | null; severity: string; activeHazard: boolean; passage: string; accessibility: string; firstReportedAt: string };
  /** Calculados por el backend; Jev no cuenta fuentes. */
  counts: { reports: number; messages: number; sources: number; repeatedEvidence: number };
  reports: AssessReportEvidence[];
  catalog: CatalogType[];
  policy: Versioned<EvaluationPolicy>;
};

export type IncidentAssessmentResult = {
  problemTypeChoice: string;
  problemTypeId: string | null;
  severity: ChoiceAnswer;
  activeFire: ChoiceAnswer;
  passage: ChoiceAnswer;
  accessibility: ChoiceAnswer;
  problemType: ChoiceAnswer;
  evolution: ChoiceAnswer;
  consistency: ChoiceAnswer;
  model: string;
};

export type AssessIncidentDeps = { jev: JevClient; recordRun: (run: AiRunRecord) => Promise<string> };

class InvalidAnswer extends Error {}

const withPreamble = (preamble: string, instructions: string) => `${preamble}\n\n${instructions}`;

/** Preguntas de la reevaluación: criterios de la evaluación de reportes + evolución y consistencia entre reportes. */
export function buildAssessQuestions(policy: EvaluationPolicy, catalog: CatalogType[]): Questions {
  const q = policy.questions;
  const a = policy.assessment;
  const questions: Questions = {};
  for (const key of ["severity", "active_fire", "passage", "accessibility"] as const) {
    const criteria: Record<string, string> = {};
    for (const label of CHOICE_LABELS[key]) criteria[label] = q[key].criteria[label] ?? label;
    questions[key] = choice(withPreamble(a.preamble, q[key].instructions), criteria);
  }
  const typeCriteria: Record<string, string> = {};
  for (const t of catalog) typeCriteria[t.slug] = describeType(t);
  typeCriteria.other = q.problem_type.other;
  typeCriteria.unknown = q.problem_type.unknown;
  questions.problem_type = choice(withPreamble(a.preamble, q.problem_type.instructions), typeCriteria);
  const crit = (labels: readonly string[], spec: { criteria: Record<string, string> }) =>
    Object.fromEntries(labels.map((l) => [l, spec.criteria[l] ?? l]));
  questions.evolution = choice(withPreamble(a.preamble, a.evolution.instructions), crit(EVOLUTION, a.evolution));
  questions.reports_consistency = choice(withPreamble(a.preamble, a.consistency.instructions), crit(REPORTS_CONSISTENCY, a.consistency));
  return questions;
}

function choiceOf(answers: Record<string, unknown>, key: string, allowed: readonly string[]): ChoiceAnswer {
  const parsed = ChoiceAnswerSchema.safeParse(answers[key]);
  if (!parsed.success) throw new InvalidAnswer(`respuesta '${key}' ausente o con forma inválida`);
  if (!allowed.includes(parsed.data.choice)) throw new InvalidAnswer(`'${key}' devolvió una opción fuera del input: ${parsed.data.choice}`);
  return parsed.data;
}

/** Respuesta cruda → contrato interno. Pura: valida cada opción contra el input permitido. */
export function mapAssessAnswers(raw: Record<string, unknown>, catalog: CatalogType[], model: string): IncidentAssessmentResult {
  const problemType = choiceOf(raw, "problem_type", [...catalog.map((t) => t.slug), ...SPECIAL_TYPES]);
  return {
    problemType,
    problemTypeChoice: problemType.choice,
    problemTypeId: catalog.find((t) => t.slug === problemType.choice)?.id ?? null,
    severity: choiceOf(raw, "severity", CHOICE_LABELS.severity),
    activeFire: choiceOf(raw, "active_fire", CHOICE_LABELS.active_fire),
    passage: choiceOf(raw, "passage", CHOICE_LABELS.passage),
    accessibility: choiceOf(raw, "accessibility", CHOICE_LABELS.accessibility),
    evolution: choiceOf(raw, "evolution", EVOLUTION),
    consistency: choiceOf(raw, "reports_consistency", REPORTS_CONSISTENCY),
    model,
  };
}

/**
 * Reevalúa el incidente con la evidencia ORIGINAL de sus reportes (no paráfrasis). Los reportes van con índices
 * locales (r1, r2…); los ids viven solo en `ai_runs.input_refs`. Registra la corrida haya éxito o no.
 */
export async function assessIncident(input: AssessIncidentInput, deps: AssessIncidentDeps): Promise<AiResult<IncidentAssessmentResult>> {
  const policy = input.policy.config;
  const a = policy.assessment;
  const questions = buildAssessQuestions(policy, input.catalog);
  let photosLeft = a.max_photos;
  const refs: Record<string, string> = {};
  const photoRefs: Record<string, string> = {};
  const reports: ContentValue[] = input.reports.map((r, i) => {
    const ref = `r${i + 1}`;
    refs[ref] = r.reportId;
    const photos = r.images.slice(0, Math.max(0, photosLeft)).map((img, j) => {
      photoRefs[`${ref}p${j + 1}`] = img.attachmentId;
      return { ref: `${ref}p${j + 1}`, image: image(img.bytes) };
    });
    photosLeft -= photos.length;
    return { ref, confirmed_at: r.confirmedAt, messages: r.messages.map((m) => m.body), photos };
  });
  const state: { [key: string]: ContentValue } = {
    incident: {
      first_reported_at: input.current.firstReportedAt,
      current_values: {
        problem_type: input.current.problemType,
        severity: input.current.severity,
        active_hazard: input.current.activeHazard,
        passage: input.current.passage,
        accessibility: input.current.accessibility,
      },
      counts_computed_by_system: {
        reports: input.counts.reports,
        messages: input.counts.messages,
        estimated_distinct_sources: input.counts.sources,
        repeated_identical_evidence: input.counts.repeatedEvidence,
      },
    },
    reports,
  };
  const withImages = Object.keys(photoRefs).length > 0 && policy.image_header;
  const inputRefs = {
    incident_id: input.incidentId,
    incident_revision: input.incidentRevision,
    reports: refs,
    photos: photoRefs,
    policy_version_id: input.policy.id,
  };
  const base = { purpose: "assess" as const, provider: "jev", modelRequested: policy.model, inputRefs, request: { state, questions } };

  let res;
  try {
    res = await deps.jev.systemOne({ model: policy.model, state, questions, withImages, timeoutMs: a.timeout_ms });
  } catch (err) {
    const error = toAiError(err);
    const aiRunId = await deps.recordRun({ ...base, status: error.kind === "timeout" ? "timeout" : "error", error: error.message });
    return { ok: false, error, aiRunId };
  }
  const record = { ...base, modelReturned: res.data.model, requestId: res.requestId, response: res.data.answers, usage: res.data.usage, latencyMs: res.latencyMs };
  try {
    const value = mapAssessAnswers(res.data.answers as Record<string, unknown>, input.catalog, res.data.model);
    const aiRunId = await deps.recordRun({ ...record, status: "ok" });
    return { ok: true, value, aiRunId };
  } catch (err) {
    if (!(err instanceof InvalidAnswer)) throw err;
    const aiRunId = await deps.recordRun({ ...record, status: "invalid", error: err.message });
    return { ok: false, error: { kind: "invalid", message: err.message }, aiRunId };
  }
}
