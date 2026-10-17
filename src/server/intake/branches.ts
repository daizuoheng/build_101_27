import type { IntakePolicy } from "../config/policies";
import { chosenProbability } from "../ai/jev/thresholds";
import type { ClarifyReason } from "../ai/llm/clarify";
import type { ChoiceAnswer, ReportEvaluation } from "@/shared/contracts/evaluation";

export type Branch =
  | { kind: "orient" }
  | { kind: "status" }
  | { kind: "ask_location" }
  | { kind: "extract_address" }
  | { kind: "ask_evidence"; requestedField: "photo" | "description" }
  | { kind: "interpret_correction" }
  | { kind: "ready"; needsReview: boolean };

const p = (ev: ReportEvaluation, key: string) => chosenProbability(ev.answers[key] as ChoiceAnswer);

/**
 * Rama conversacional según la evaluación de Jev y la política de recepción. Pura.
 * El LLM no participa de esta decisión.
 *
 * `textAfterReady`: la persona escribió texto nuevo después de que se le mostró la ficha lista. Es una señal
 * estructural de la conversación (no del LLM) de que puede estar corrigiendo el borrador.
 */
export function chooseBranch(
  ev: ReportEvaluation,
  draft: { locationConfirmed: boolean; textAfterReady?: boolean },
  policy: Pick<IntakePolicy, "thresholds" | "max_clarification_rounds">,
  rounds: number,
): Branch {
  const t = policy.thresholds;
  const canAsk = rounds < policy.max_clarification_rounds;
  // Una intención no-reporte poco segura se trata como reporte: preferimos preguntar a descartar.
  if (ev.intent === "other" && p(ev, "intent") >= (t.intent ?? 0)) return { kind: "orient" };
  if (ev.intent === "status_query" && p(ev, "intent") >= (t.intent ?? 0)) return { kind: "status" };
  if (ev.applicability === "unrelated" && ev.intent !== "report") return { kind: "orient" };

  if (ev.applicability === "insufficient" && canAsk) return { kind: "ask_evidence", requestedField: "description" };

  if (!draft.locationConfirmed) {
    const precise = ev.locationInText === "precise" && p(ev, "location_in_text") >= (t.location_in_text ?? 0);
    return precise ? { kind: "extract_address" } : { kind: "ask_location" };
  }

  if (draft.textAfterReady) return { kind: "interpret_correction" };

  const badPhoto = ev.photoQuality === "insufficient" && p(ev, "photo_quality") >= (t.photo_quality ?? 0);
  const contradiction = ev.contradiction === "contradiction" && p(ev, "text_photo_consistency") >= (t.contradiction ?? 0);
  if ((badPhoto || contradiction) && canAsk) return { kind: "ask_evidence", requestedField: "photo" };

  return { kind: "ready", needsReview: ev.needsReview || ev.applicability === "insufficient" };
}

/** Motivos de la repregunta, derivados de la evaluación. Pura: el LLM solo los redacta. */
export function evidenceReasons(ev: ReportEvaluation, requestedField: "photo" | "description"): ClarifyReason[] {
  if (requestedField === "description") return ["description_insufficient"];
  const reasons: ClarifyReason[] = [];
  if (ev.photoQuality === "insufficient") reasons.push("photo_insufficient");
  if (ev.contradiction === "contradiction") reasons.push("text_photo_contradiction");
  return reasons.length ? reasons : ["photo_insufficient"];
}

/** Peligro activo según la evaluación (Choice o Noul de la foto). */
export function indicatesActiveHazard(ev: ReportEvaluation): boolean {
  const photoFire = ev.answers.fact_photo_shows_fire;
  return ev.activeFire === "yes" || (photoFire?.type === "noul" && photoFire.noul >= 0.5);
}
