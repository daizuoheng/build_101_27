// Contratos de las llamadas LLM de recepción. El LLM es un doble CLARAMENTE simulado; la integración real va por smoke.
import { describe, expect, it } from "vitest";
import type { LlmCallConfig, LlmClient } from "@/server/ai/llm/client";
import type { LlmRunRecord } from "@/server/ai/runs";
import { clarify } from "@/server/ai/llm/clarify";
import { interpretCorrection } from "@/server/ai/llm/interpret-correction";
import { extractAddress } from "@/server/ai/llm/extract-address";

const config: LlmCallConfig = { model: "fake", instructions_version: "test", max_output_tokens: 100, timeout_ms: 1000, extra_body: {} };

/** LLM falso que devuelve las salidas en orden (string crudo, objeto a serializar o Error a lanzar). */
function fakeLlm(...outputs: (string | object | Error)[]) {
  const runs: LlmRunRecord[] = [];
  let calls = 0;
  const llm: LlmClient = {
    provider: "fake",
    async completeJson() {
      const out = outputs[Math.min(calls++, outputs.length - 1)];
      if (out instanceof Error) throw out;
      return { content: typeof out === "string" ? out : JSON.stringify(out), latencyMs: 1 };
    },
  };
  return { deps: { llm, recordRun: async (r: LlmRunRecord) => (runs.push(r), `run-${runs.length}`) }, runs, calls: () => calls };
}

const msgs = [
  { id: "m1", body: "hay un pozo enorme en Rivera y Comercio" },
  { id: "m2", body: "perdón, es en Rivera y Soca" },
];
const base = { reportId: "r1", revision: 3, config };

describe("clarify", () => {
  it("devuelve la repregunta y registra la corrida", async () => {
    const f = fakeLlm({ question: "¿Podés sacar otra foto más cerca del pozo?", requested_field: "photo" });
    const res = await clarify(f.deps, { ...base, requestedField: "photo", reasons: ["photo_insufficient"], messages: msgs });
    expect(res).toEqual({ ok: true, llmRunId: "run-1", value: { question: "¿Podés sacar otra foto más cerca del pozo?", requestedField: "photo" } });
    expect(f.runs[0]).toMatchObject({ purpose: "clarify", status: "ok", entityRef: { report_id: "r1", report_revision: 3 } });
  });

  it("rechaza un requested_field distinto del pedido por el backend", async () => {
    const f = fakeLlm({ question: "¿Dónde queda exactamente?", requested_field: "description" });
    const res = await clarify(f.deps, { ...base, requestedField: "photo", reasons: ["photo_insufficient"], messages: msgs });
    expect(res.ok).toBe(false);
    expect(f.calls()).toBe(2); // un reintento y después error
    expect(f.runs.map((r) => r.status)).toEqual(["invalid", "invalid"]);
  });

  it("salida no JSON ⇒ reintento; error del proveedor ⇒ ok false sin lanzar", async () => {
    const recovered = fakeLlm("no es json", { question: "¿Qué es lo que pasa en la vereda?", requested_field: "description" });
    expect((await clarify(recovered.deps, { ...base, requestedField: "description", reasons: ["description_insufficient"], messages: msgs })).ok).toBe(true);

    const down = fakeLlm(new Error("Request timed out."));
    const res = await clarify(down.deps, { ...base, requestedField: "description", reasons: ["description_insufficient"], messages: msgs });
    expect(res).toMatchObject({ ok: false, llmRunId: "run-1" });
    expect(down.runs[0].status).toBe("timeout");
  });
});

describe("interpretCorrection", () => {
  const draft = { description: "hay un pozo enorme en Rivera y Comercio", locationText: "Rivera y Comercio", areaName: "BUCEO" };

  it("propone la nueva ubicación citando el mensaje fuente", async () => {
    const f = fakeLlm({ proposed_fields: { location_text: "Rivera y Soca" }, source_message_ids: ["m2"] });
    const res = await interpretCorrection(f.deps, { ...base, draft, newMessages: [msgs[1]] });
    expect(res).toEqual({ ok: true, llmRunId: "run-1", value: { proposedFields: { locationText: "Rivera y Soca" }, sourceMessageIds: ["m2"] } });
  });

  it("sourceMessageIds con un id inexistente ⇒ rechazo tipado", async () => {
    const f = fakeLlm({ proposed_fields: { location_text: "Rivera y Soca" }, source_message_ids: ["m2", "inventado"] });
    const res = await interpretCorrection(f.deps, { ...base, draft, newMessages: [msgs[1]] });
    expect(res).toMatchObject({ ok: false, error: "source_message_ids fuera del input" });
    expect(f.runs.every((r) => r.status === "invalid")).toBe(true);
  });

  it("citar un mensaje viejo (no nuevo) también se rechaza", async () => {
    const f = fakeLlm({ proposed_fields: { location_text: "Rivera y Soca" }, source_message_ids: ["m1"] });
    expect((await interpretCorrection(f.deps, { ...base, draft, newMessages: [msgs[1]] })).ok).toBe(false);
  });

  it("un cambio sin fuente se rechaza; sin cambios es válido y vacío", async () => {
    const noSource = fakeLlm({ proposed_fields: { location_text: "Rivera y Soca" }, source_message_ids: [] });
    expect((await interpretCorrection(noSource.deps, { ...base, draft, newMessages: [msgs[1]] })).ok).toBe(false);

    const none = fakeLlm({ proposed_fields: {}, source_message_ids: [] });
    expect(await interpretCorrection(none.deps, { ...base, draft, newMessages: [msgs[1]] })).toEqual({
      ok: true, llmRunId: "run-1", value: { proposedFields: {}, sourceMessageIds: [] },
    });
  });

  it("campos fuera del contrato (p. ej. estado o severidad) invalidan la salida", async () => {
    const f = fakeLlm({ proposed_fields: { severity: "high" }, source_message_ids: ["m2"] });
    expect((await interpretCorrection(f.deps, { ...base, draft, newMessages: [msgs[1]] })).ok).toBe(false);
  });
});

describe("extractAddress", () => {
  it("sourceMessageIds con un id inexistente ⇒ rechazo tipado", async () => {
    const f = fakeLlm({ address: "Rivera y Comercio", source_message_ids: ["zzz"] });
    const res = await extractAddress(f.deps, { ...base, messages: msgs, territoryName: "Montevideo" });
    expect(res).toMatchObject({ ok: false, error: "source_message_ids fuera del input" });
  });
});
