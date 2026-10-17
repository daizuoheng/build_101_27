import { describe, expect, it } from "vitest";
import { policies } from "../../seeds/policies";
import { chooseBranch } from "@/server/intake/branches";
import { computePriority } from "@/server/pipeline/priority";
import { IntakePolicy, PriorityPolicy } from "@/server/config/policies";
import type { ReportEvaluation } from "@/shared/contracts/evaluation";

const intake = IntakePolicy.parse(policies.intake);
const c = (choice: string, p = 0.97) => ({ type: "choice" as const, choice, confidence: 0.9, probabilities: { [choice]: p } });

function ev(over: Partial<ReportEvaluation> = {}): ReportEvaluation {
  const base: ReportEvaluation = {
    intent: "report", applicability: "applicable", problemTypeChoice: "bache", problemTypeId: null, severity: "medium",
    activeFire: "no", passage: "partial", accessibility: "not_affected", locationInText: "absent", photoQuality: "no_photo",
    contradiction: "not_evaluable", needsReview: false, reviewReasons: [], model: "m", answers: {},
  };
  const merged = { ...base, ...over };
  merged.answers = {
    intent: c(merged.intent), location_in_text: c(merged.locationInText), photo_quality: c(merged.photoQuality),
    text_photo_consistency: c(merged.contradiction), ...over.answers,
  };
  return merged;
}

describe("chooseBranch", () => {
  it("cubre las ramas del diseño", () => {
    expect(chooseBranch(ev({ intent: "other" }), { locationConfirmed: false }, intake, 0)).toEqual({ kind: "orient" });
    expect(chooseBranch(ev({ intent: "status_query" }), { locationConfirmed: false }, intake, 0)).toEqual({ kind: "status" });
    expect(chooseBranch(ev(), { locationConfirmed: false }, intake, 0)).toEqual({ kind: "ask_location" });
    expect(chooseBranch(ev({ locationInText: "precise" }), { locationConfirmed: false }, intake, 0)).toEqual({ kind: "extract_address" });
    expect(chooseBranch(ev({ photoQuality: "insufficient" }), { locationConfirmed: true }, intake, 0)).toEqual({ kind: "ask_evidence", requestedField: "photo" });
    expect(chooseBranch(ev({ photoQuality: "insufficient" }), { locationConfirmed: true }, intake, 2)).toEqual({ kind: "ready", needsReview: false });
    expect(chooseBranch(ev(), { locationConfirmed: true }, intake, 0)).toEqual({ kind: "ready", needsReview: false });
  });

  it("una intención 'other' poco segura no descarta el reporte", () => {
    const e = ev({ intent: "other", answers: { intent: c("other", 0.4) } });
    expect(chooseBranch(e, { locationConfirmed: false }, intake, 0).kind).toBe("ask_location");
  });
});

describe("computePriority", () => {
  const policy = PriorityPolicy.parse(policies.priority);
  const now = new Date("2026-10-17T20:00:00Z");
  const base = { severity: "low" as const, activeHazard: false, passage: "none" as const, accessibility: "not_affected" as const };

  it("fuego activo ⇒ alta aunque la severidad sea baja", () => {
    expect(computePriority({ ...base, activeHazard: true }, now, now, policy).band).toBe("high");
  });
  it("baja con más de 48 h ⇒ media, con la promoción registrada", () => {
    const r = computePriority(base, new Date(now.getTime() - 49 * 3_600_000), now, policy);
    expect(r.band).toBe("medium");
    expect(r.breakdown.promoted_by_age).toBe(true);
  });
  it("accesibilidad afectada o bloqueo total ⇒ alta", () => {
    expect(computePriority({ ...base, accessibility: "affected" }, now, now, policy).band).toBe("high");
    expect(computePriority({ ...base, passage: "total" }, now, now, policy).band).toBe("high");
  });
  it("indeterminada ⇒ unknown", () => {
    expect(computePriority({ ...base, severity: "undetermined" }, now, now, policy).band).toBe("unknown");
  });
});
