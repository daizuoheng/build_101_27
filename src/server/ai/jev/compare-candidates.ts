import { choice, image, noul, type ContentValue, type Questions } from "@typesafe-ai/sdk";
import type { GroupingPolicy, Versioned } from "@/server/config/policies";
import type { AiRunRecord } from "@/server/ai/runs";
import { ChoiceAnswerSchema, NoulAnswerSchema, type AiResult, type ChoiceAnswer } from "@/shared/contracts/evaluation";
import { toAiError, type JevClient } from "./client";
import { chosenProbability, noulVerdict } from "./thresholds";

export const MATCH_LABELS = ["same_incident", "different_incident", "uncertain"] as const;
export const CONFLICTS = ["object", "place", "time"] as const;
type Conflict = (typeof CONFLICTS)[number];

type Message = { id: string; body: string; createdAt: string };
type Photo = { attachmentId: string; bytes: Buffer; format: "jpeg" | "png" };

export type CandidateInput = {
  incidentId: string;
  distanceM: number;
  summary: { category: string | null; status: string; firstReportedAt: string; reportCount: number };
  evidence: { reports: { reportId: string; confirmedAt: string; messages: Message[]; images: Photo[] }[] };
};

export type CompareCandidatesInput = {
  reportId: string;
  reportRevision: number;
  report: { confirmedAt: string; messages: Message[]; images: Photo[]; location: { text: string | null; areaName: string | null } };
  candidates: CandidateInput[];
  truncated: boolean;
  policy: Versioned<GroupingPolicy>;
};

export type CandidateComparison = {
  ref: string;
  incidentId: string;
  distanceM: number;
  match: ChoiceAnswer;
  conflicts: Record<Conflict, number>;
};

export type GroupingVerdict =
  | { kind: "link"; incidentId: string; reasons: string[] }
  | { kind: "create"; reasons: string[] }
  | { kind: "review"; reasons: string[] };

export type CandidatesComparison = { perCandidate: CandidateComparison[]; verdict: GroupingVerdict; model: string };

export type CompareCandidatesDeps = { jev: JevClient; recordRun: (run: AiRunRecord) => Promise<string> };

/** Índice local del candidato en el estado y en las preguntas. El modelo solo ve estos índices. */
export const candidateRef = (i: number) => `c${i + 1}`;

const fill = (text: string, ref: string) => text.replaceAll("{candidate}", ref);

/** Preguntas por candidato: textos y criterios de la política; estructura (claves y opciones) del código. */
export function buildCompareQuestions(policy: GroupingPolicy, refs: string[]): Questions {
  const q = policy.questions;
  const questions: Questions = {};
  for (const ref of refs) {
    const criteria: Record<string, string> = {};
    for (const label of MATCH_LABELS) criteria[label] = fill(q.match.criteria[label], ref);
    questions[`match_${ref}`] = choice(fill(q.match.instructions, ref), criteria);
    for (const k of CONFLICTS) questions[`${k}_conflict_${ref}`] = noul(fill(q[`${k}_conflict`].instructions, ref));
  }
  return questions;
}

/**
 * Decisión de agrupación, pura. Contra `probabilities[choice]` y `noul`, nunca contra `confidence`.
 * link: exactamente un `same` ≥ umbral sin conflicto por encima de la banda y el resto `different` ≥ umbral.
 * create: sin candidatos o todos `different` ≥ umbral. review: cualquier otro caso o candidatos truncados.
 */
export function decideGrouping(perCandidate: CandidateComparison[], policy: GroupingPolicy, opts: { truncated?: boolean } = {}): GroupingVerdict {
  const reasons: string[] = [];
  if (opts.truncated) reasons.push("candidates_truncated");
  const isDifferent = (c: CandidateComparison) =>
    c.match.choice === "different_incident" && chosenProbability(c.match) >= policy.different_threshold;
  const same = perCandidate.filter((c) => c.match.choice === "same_incident");
  const rest = perCandidate.filter((c) => c.match.choice !== "same_incident");
  const undecided = rest.filter((c) => !isDifferent(c));
  for (const c of undecided) reasons.push(c.match.choice === "uncertain" ? `uncertain:${c.ref}` : `weak_different:${c.ref}`);

  if (same.length === 0) {
    if (undecided.length === 0 && !opts.truncated) return { kind: "create", reasons: perCandidate.length ? ["all_different"] : ["no_candidates"] };
    return { kind: "review", reasons };
  }
  if (same.length > 1) return { kind: "review", reasons: [...reasons, `multiple_same:${same.map((c) => c.ref).join(",")}`] };

  const [s] = same;
  if (chosenProbability(s.match) < policy.same_threshold) reasons.push(`weak_same:${s.ref}`);
  for (const k of CONFLICTS) {
    if (noulVerdict(s.conflicts[k], policy.conflict_band) === "yes") reasons.push(`${k}_conflict:${s.ref}`);
  }
  if (reasons.length) return { kind: "review", reasons };
  return { kind: "link", incidentId: s.incidentId, reasons: [`same_incident:${s.ref}`] };
}

class InvalidAnswer extends Error {}

/** Traduce la respuesta cruda al contrato interno y vuelve de índices locales a ids. Valida contra el input permitido. */
export function mapCompareAnswers(raw: Record<string, unknown>, candidates: CandidateInput[]): CandidateComparison[] {
  return candidates.map((c, i) => {
    const ref = candidateRef(i);
    const m = ChoiceAnswerSchema.safeParse(raw[`match_${ref}`]);
    if (!m.success) throw new InvalidAnswer(`respuesta 'match_${ref}' ausente o con forma inválida`);
    if (!(MATCH_LABELS as readonly string[]).includes(m.data.choice)) {
      throw new InvalidAnswer(`'match_${ref}' devolvió una opción fuera del input: ${m.data.choice}`);
    }
    const conflicts = {} as Record<Conflict, number>;
    for (const k of CONFLICTS) {
      const n = NoulAnswerSchema.safeParse(raw[`${k}_conflict_${ref}`]);
      if (!n.success) throw new InvalidAnswer(`respuesta '${k}_conflict_${ref}' ausente o inválida`);
      conflicts[k] = n.data.noul;
    }
    return { ref, incidentId: c.incidentId, distanceM: c.distanceM, match: m.data, conflicts };
  });
}

/**
 * Compara un reporte nuevo contra los incidentes candidatos en una sola llamada a Jev.
 * Jev recibe evidencia original de ambos lados (textos y fotos derivadas) con índices locales; los ids quedan en `input_refs`.
 */
export async function compareCandidates(input: CompareCandidatesInput, deps: CompareCandidatesDeps): Promise<AiResult<CandidatesComparison>> {
  const policy = input.policy.config;
  const refs = input.candidates.map((_, i) => candidateRef(i));
  const photoRefs: Record<string, string> = {};
  const photos = (prefix: string, images: Photo[]) =>
    images.map((img, j) => {
      const ref = `${prefix}_p${j + 1}`;
      photoRefs[ref] = img.attachmentId;
      return { ref, image: image(img.bytes) };
    });
  const messages = (ms: Message[]) => ms.map((m) => ({ sent_at: m.createdAt, text: m.body }));

  const candidates: { [ref: string]: ContentValue } = {};
  input.candidates.forEach((c, i) => {
    const ref = refs[i];
    let budget = policy.evidence.max_photos_per_candidate;
    candidates[ref] = {
      distance_m: Math.round(c.distanceM),
      status: c.summary.status,
      category: c.summary.category,
      first_reported_at: c.summary.firstReportedAt,
      report_count: c.summary.reportCount,
      reports: c.evidence.reports.map((r, j) => {
        const imgs = r.images.slice(0, Math.max(0, budget));
        budget -= imgs.length;
        return { received_at: r.confirmedAt, messages: messages(r.messages), photos: photos(`${ref}_r${j + 1}`, imgs) };
      }),
    };
  });
  const state: { [key: string]: ContentValue } = {
    new_report: {
      received_at: input.report.confirmedAt,
      location: { description: input.report.location.text, area: input.report.location.areaName },
      messages: messages(input.report.messages),
      photos: photos("new", input.report.images),
    },
    candidates,
  };
  const questions = buildCompareQuestions(policy, refs);
  const withImages = Object.keys(photoRefs).length > 0 && policy.image_header;
  const inputRefs = {
    report_id: input.reportId,
    report_revision: input.reportRevision,
    candidates: Object.fromEntries(input.candidates.map((c, i) => [refs[i], c.incidentId])),
    truncated: input.truncated,
    photos: photoRefs,
    policy_version_id: input.policy.id,
  };
  const base = { purpose: "compare" as const, provider: "jev", modelRequested: policy.model, inputRefs, request: { state, questions } };

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
    const perCandidate = mapCompareAnswers(res.data.answers as Record<string, unknown>, input.candidates);
    const verdict = decideGrouping(perCandidate, policy, { truncated: input.truncated });
    const aiRunId = await deps.recordRun({ ...record, status: "ok" });
    return { ok: true, value: { perCandidate, verdict, model: res.data.model }, aiRunId };
  } catch (err) {
    if (!(err instanceof InvalidAnswer)) throw err;
    const aiRunId = await deps.recordRun({ ...record, status: "invalid", error: err.message });
    return { ok: false, error: { kind: "invalid", message: err.message }, aiRunId };
  }
}
