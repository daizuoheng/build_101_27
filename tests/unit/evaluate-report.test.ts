// Tests unitarios con respuestas de Jev en fixture (forma documentada del SDK). La integración real se prueba con `pnpm cli smoke-jev`.
import { describe, expect, it } from "vitest";
import { policies } from "../../seeds/policies";
import { problemTypes } from "../../seeds/catalog";
import { buildReportQuestions, evaluateReport, mapReportAnswers } from "@/server/ai/jev/evaluate-report";
import { meetsThreshold, noulVerdict } from "@/server/ai/jev/thresholds";
import { EvaluationPolicy } from "@/server/config/policies";
import type { JevClient } from "@/server/ai/jev/client";

const policy = EvaluationPolicy.parse(policies.evaluation);
const catalog = problemTypes.map((t, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`.slice(0, 36),
  slug: t.slug,
  name: t.name,
  description: t.description,
  criteria: t.criteria,
}));

const c = (choice: string, p = 0.97) => ({ type: "choice" as const, choice, confidence: 0.9, probabilities: { [choice]: p } });

function answers(over: Record<string, unknown> = {}) {
  return {
    intent: c("report"),
    applicability: c("applicable"),
    problem_type: c("accesibilidad_obstruida"),
    severity: c("high"),
    active_fire: c("no"),
    passage: c("partial"),
    accessibility: c("affected"),
    location_in_text: c("precise"),
    photo_quality: c("no_photo"),
    text_photo_consistency: c("not_evaluable"),
    fact_photo_shows_fire: { type: "noul", noul: 0.02 },
    fact_recurring_problem_claimed: { type: "noul", noul: 0.1 },
    ...over,
  };
}

describe("umbrales", () => {
  it("exigen opción favorable y probabilidad de esa opción", () => {
    const a = { type: "choice" as const, choice: "applicable", confidence: 0.5, probabilities: { applicable: 0.93, unrelated: 0.07 } };
    expect(meetsThreshold(a, ["applicable"], 0.9)).toBe(true);
    expect(meetsThreshold({ ...a, choice: "unrelated" }, ["applicable"], 0.9)).toBe(false);
    expect(noulVerdict(0.52, 0.1)).toBe("uncertain");
    expect(noulVerdict(0.95, 0.1)).toBe("yes");
  });
});

describe("evaluateReport", () => {
  it("arma una pregunta por campo, el tipo desde el catálogo activo y los Noul de la política", () => {
    const q = buildReportQuestions(policy, catalog);
    expect(Object.keys(q)).toEqual(expect.arrayContaining(["intent", "applicability", "problem_type", "fact_photo_shows_fire"]));
    const types = Object.keys((q.problem_type as { criteria: Record<string, unknown> }).criteria);
    expect(types).toEqual([...catalog.map((t) => t.slug), "other", "unknown"]);
  });

  it("mapea una respuesta válida sin revisión", () => {
    const ev = mapReportAnswers(answers(), catalog, policy, "jev-1.14.0");
    expect(ev.problemTypeId).toBe(catalog[2].id);
    expect(ev.needsReview).toBe(false);
  });

  it("marca contradicción texto-foto para revisión", () => {
    const ev = mapReportAnswers(answers({ text_photo_consistency: c("contradiction", 0.8) }), catalog, policy, "m");
    expect(ev.needsReview).toBe(true);
    expect(ev.reviewReasons).toContain("contradiction");
  });

  it("baja probabilidad de aplicabilidad o tipo desconocido van a revisión", () => {
    expect(mapReportAnswers(answers({ applicability: c("applicable", 0.7) }), catalog, policy, "m").reviewReasons).toContain("low_confidence");
    expect(mapReportAnswers(answers({ problem_type: c("other") }), catalog, policy, "m").reviewReasons).toContain("unknown_type");
  });

  it("rechaza con error tipado un tipo fuera del catálogo y registra la corrida", async () => {
    const runs: string[] = [];
    const jev: JevClient = { systemOne: async () => ({ data: { model: "m", answers: answers({ problem_type: c("volcan") }), usage: { input_tokens: 1, output_tokens: 1 } } as never, latencyMs: 5 }) };
    const r = await evaluateReport(
      {
        reportId: "r", reportRevision: 1, messages: [{ id: "m1", body: "x", createdAt: "" }], images: [],
        location: { confirmed: false, text: null, areaName: null }, catalog, catalogHash: "h", policy: { id: "p", version: 1, config: policy },
      },
      { jev, recordRun: async (run) => (runs.push(run.status), "run-1") },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid");
    expect(runs).toEqual(["invalid"]);
  });
});
