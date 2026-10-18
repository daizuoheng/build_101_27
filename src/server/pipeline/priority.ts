import type { PriorityPolicy } from "../config/policies";

export type PriorityInput = {
  severity: "low" | "medium" | "high" | "undetermined";
  activeHazard: boolean;
  passage: "total" | "partial" | "none" | "undetermined";
  accessibility: "affected" | "partial" | "not_affected" | "undetermined";
};

export type PriorityBand = "high" | "medium" | "low" | "unknown";

/**
 * Banda por riesgo/impacto según reglas de política, más promoción por antigüedad. Pura.
 * El volumen de reportes NO entra acá: solo suma un bonus acotado dentro de la banda, en el planificador.
 */
export function computePriority(e: PriorityInput, createdAt: Date, now: Date, policy: PriorityPolicy): { band: PriorityBand; breakdown: Record<string, unknown> } {
  const rules: string[] = [];
  if (policy.high.severity.includes(e.severity)) rules.push("severity_high");
  if (policy.high.active_hazard && e.activeHazard) rules.push("active_hazard");
  if (policy.high.passage.includes(e.passage)) rules.push("passage_blocked");
  if (policy.high.accessibility.includes(e.accessibility)) rules.push("accessibility_affected");
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);

  const medium: string[] = [];
  if (policy.medium.severity.includes(e.severity)) medium.push("severity_medium");
  if (policy.medium.accessibility.includes(e.accessibility)) medium.push(e.accessibility === "partial" ? "accessibility_partial" : "accessibility_affected");

  let band: PriorityBand;
  let promoted = false;
  if (rules.length) band = "high";
  else if (medium.length) {
    band = "medium";
    rules.push(...medium);
  } else if (e.severity === "low") {
    band = "low";
    if (ageHours > policy.promote_low_to_medium_after_hours) {
      band = "medium";
      promoted = true;
    }
  } else band = "unknown";

  return {
    band,
    breakdown: {
      rules,
      promoted_by_age: promoted,
      age_hours: Math.round(ageHours * 10) / 10,
      inputs: e,
      computed_at: now.toISOString(),
    },
  };
}
