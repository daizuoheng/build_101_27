import type { ChoiceAnswer } from "@/shared/contracts/evaluation";

/** Respuesta favorable Y probabilidad de la opción elegida ≥ umbral. Nunca `confidence` sola. */
export function meetsThreshold(answer: ChoiceAnswer, favorable: readonly string[], min: number): boolean {
  if (!favorable.includes(answer.choice)) return false;
  return (answer.probabilities[answer.choice] ?? 0) >= min;
}

/** Probabilidad de la opción elegida. */
export function chosenProbability(answer: ChoiceAnswer): number {
  return answer.probabilities[answer.choice] ?? 0;
}

/** Noul contra su probabilidad, con banda de incertidumbre alrededor de 0,5. */
export function noulVerdict(p: number, band: number): "yes" | "no" | "uncertain" {
  if (p >= 0.5 + band) return "yes";
  if (p <= 0.5 - band) return "no";
  return "uncertain";
}
