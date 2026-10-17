// Tests unitarios con respuestas de Jev simuladas (forma documentada del SDK). La integración real se prueba con `pnpm cli smoke-jev`.
import { describe, expect, it } from "vitest";
import { policies } from "../../seeds/policies";
import {
  buildCompareQuestions,
  compareCandidates,
  decideGrouping,
  type CandidateComparison,
  type CandidateInput,
} from "@/server/ai/jev/compare-candidates";
import type { JevCall, JevClient } from "@/server/ai/jev/client";
import type { AiRunRecord } from "@/server/ai/runs";
import { GroupingPolicy } from "@/server/config/policies";

const policy = GroupingPolicy.parse(policies.grouping);
const INC_A = "aaaaaaaa-0000-4000-8000-000000000001";
const INC_B = "bbbbbbbb-0000-4000-8000-000000000002";

function cmp(ref: string, incidentId: string, match: string, p: number, conflicts: Partial<CandidateComparison["conflicts"]> = {}): CandidateComparison {
  return {
    ref, incidentId, distanceM: 5,
    match: { type: "choice", choice: match, confidence: 0.8, probabilities: { [match]: p } },
    conflicts: { object: 0.05, place: 0.05, time: 0.05, ...conflicts },
  };
}

describe("decideGrouping", () => {
  it("un same 0,95 y un different 0,92 ⇒ link al same", () => {
    const v = decideGrouping([cmp("c1", INC_A, "different_incident", 0.92), cmp("c2", INC_B, "same_incident", 0.95)], policy);
    expect(v).toMatchObject({ kind: "link", incidentId: INC_B });
  });

  it("dos same ⇒ review", () => {
    const v = decideGrouping([cmp("c1", INC_A, "same_incident", 0.95), cmp("c2", INC_B, "same_incident", 0.97)], policy);
    expect(v.kind).toBe("review");
    expect(v.reasons).toContain("multiple_same:c1,c2");
  });

  it("un same 0,95 con place_conflict 0,8 ⇒ review", () => {
    const v = decideGrouping([cmp("c1", INC_A, "same_incident", 0.95, { place: 0.8 })], policy);
    expect(v).toEqual({ kind: "review", reasons: ["place_conflict:c1"] });
  });

  it("sin candidatos ⇒ create", () => {
    expect(decideGrouping([], policy).kind).toBe("create");
  });

  it("todos different con evidencia suficiente ⇒ create; uno débil ⇒ review", () => {
    expect(decideGrouping([cmp("c1", INC_A, "different_incident", 0.9), cmp("c2", INC_B, "different_incident", 0.85)], policy).kind).toBe("create");
    expect(decideGrouping([cmp("c1", INC_A, "different_incident", 0.9), cmp("c2", INC_B, "different_incident", 0.6)], policy).kind).toBe("review");
  });

  it("same por debajo del umbral, uncertain o candidatos truncados ⇒ review", () => {
    expect(decideGrouping([cmp("c1", INC_A, "same_incident", 0.85)], policy).kind).toBe("review");
    expect(decideGrouping([cmp("c1", INC_A, "same_incident", 0.95), cmp("c2", INC_B, "uncertain", 0.9)], policy).kind).toBe("review");
    expect(decideGrouping([cmp("c1", INC_A, "same_incident", 0.95)], policy, { truncated: true }).reasons).toContain("candidates_truncated");
    expect(decideGrouping([cmp("c1", INC_A, "different_incident", 0.95)], policy, { truncated: true }).kind).toBe("review");
  });

  it("un conflicto dentro de la banda de incertidumbre no impide asociar", () => {
    expect(decideGrouping([cmp("c1", INC_A, "same_incident", 0.95, { time: 0.6 })], policy).kind).toBe("link");
  });
});

describe("compareCandidates", () => {
  const candidate = (incidentId: string, distanceM: number): CandidateInput => ({
    incidentId, distanceM,
    summary: { category: "Bache", status: "open", firstReportedAt: "2026-10-17T12:00:00.000Z", reportCount: 1 },
    evidence: { reports: [{ reportId: `r-${incidentId}`, confirmedAt: "2026-10-17T12:00:00.000Z", messages: [{ id: "m1", body: "pozo en la calle", createdAt: "2026-10-17T12:00:00.000Z" }], images: [] }] },
  });
  const input = {
    reportId: "11111111-0000-4000-8000-000000000000",
    reportRevision: 3,
    report: { confirmedAt: "2026-10-17T13:00:00.000Z", messages: [{ id: "m9", body: "hay un bache enorme", createdAt: "2026-10-17T13:00:00.000Z" }], images: [], location: { text: "18 de Julio 1234", areaName: "CENTRO" } },
    candidates: [candidate(INC_A, 4), candidate(INC_B, 11)],
    truncated: false,
    policy: { id: "pol-1", version: 1, config: policy },
  };
  const c = (choice: string, p: number) => ({ type: "choice", choice, confidence: 0.8, probabilities: { [choice]: p } });
  const n = (p: number) => ({ type: "noul", noul: p });
  const answers = {
    match_c1: c("different_incident", 0.92), object_conflict_c1: n(0.9), place_conflict_c1: n(0.1), time_conflict_c1: n(0.1),
    match_c2: c("same_incident", 0.95), object_conflict_c2: n(0.05), place_conflict_c2: n(0.05), time_conflict_c2: n(0.05),
  };

  function jevReturning(raw: Record<string, unknown>) {
    const calls: JevCall[] = [];
    const jev: JevClient = { systemOne: async (call) => (calls.push(call), { data: { model: "fake-jev", answers: raw } as never, latencyMs: 1 }) };
    const runs: AiRunRecord[] = [];
    return { jev, calls, runs, recordRun: async (r: AiRunRecord) => (runs.push(r), `run-${runs.length}`) };
  }

  it("pregunta con índices locales, sin ids en estado ni preguntas, y mapea de vuelta a los ids", async () => {
    const f = jevReturning(answers);
    const res = await compareCandidates(input, f);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.perCandidate.map((p) => [p.ref, p.incidentId])).toEqual([["c1", INC_A], ["c2", INC_B]]);
    expect(res.value.verdict).toMatchObject({ kind: "link", incidentId: INC_B });

    const call = f.calls[0];
    expect(Object.keys(call.questions).sort()).toEqual(Object.keys(answers).sort());
    const sent = JSON.stringify({ state: call.state, questions: call.questions });
    for (const id of [INC_A, INC_B, input.reportId]) expect(sent).not.toContain(id);
    expect(sent).toContain("pozo en la calle"); // evidencia original del candidato
    expect(sent).toContain("hay un bache enorme"); // y del reporte nuevo

    expect(f.runs[0]).toMatchObject({ purpose: "compare", status: "ok", inputRefs: { candidates: { c1: INC_A, c2: INC_B } } });
  });

  it("los textos de las preguntas salen de la política con el índice local", () => {
    const q = buildCompareQuestions(policy, ["c1"]) as Record<string, { type: string; description?: unknown }>;
    expect(Object.keys(q)).toEqual(["match_c1", "object_conflict_c1", "place_conflict_c1", "time_conflict_c1"]);
    expect(JSON.stringify(q)).not.toContain("{candidate}");
  });

  it("opción fuera del input o respuesta faltante ⇒ error tipado invalid y corrida registrada", async () => {
    const bad = jevReturning({ ...answers, match_c2: c("same_object", 0.99) });
    const res = await compareCandidates(input, bad);
    expect(res).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(bad.runs[0]).toMatchObject({ purpose: "compare", status: "invalid" });

    const missing = jevReturning({ ...answers, time_conflict_c1: undefined });
    expect(await compareCandidates(input, missing)).toMatchObject({ ok: false, error: { kind: "invalid" } });
  });
});
