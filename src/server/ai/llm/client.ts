import OpenAI from "openai";
import type { z } from "zod";
import type { LlmRunRecord } from "../runs";

export type LlmCallConfig = {
  model: string;
  instructions_version: string;
  max_output_tokens: number;
  timeout_ms: number;
  extra_body: Record<string, unknown>;
};

export type LlmDeps = { llm: LlmClient; recordRun: (r: LlmRunRecord) => Promise<string> };

export type LlmResult<T> = { ok: true; value: T; llmRunId: string } | { ok: false; error: string; llmRunId?: string };

/** Puerto al LLM generativo (API compatible con OpenAI; DeepSeek por defecto). */
export interface LlmClient {
  readonly provider: string;
  completeJson(args: { config: LlmCallConfig; system: string; user: string }): Promise<{ content: string; inputTokens?: number; outputTokens?: number; latencyMs: number }>;
}

let shared: OpenAI | null = null;

export function createLlmClient(): LlmClient | null {
  const apiKey = process.env.LLM_API_KEY;
  const baseURL = process.env.LLM_BASE_URL;
  if (!apiKey || !baseURL) return null;
  shared ??= new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  const client = shared;
  return {
    provider: new URL(baseURL).hostname,
    async completeJson({ config, system, user }) {
      const t0 = Date.now();
      const res = await client.chat.completions.create(
        {
          model: config.model || process.env.LLM_MODEL || "",
          max_tokens: config.max_output_tokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...config.extra_body,
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        { timeout: config.timeout_ms },
      );
      return {
        content: res.choices[0]?.message?.content ?? "",
        inputTokens: res.usage?.prompt_tokens,
        outputTokens: res.usage?.completion_tokens,
        latencyMs: Date.now() - t0,
      };
    },
  };
}

/**
 * Llamada JSON validada con Zod: salida vacía o inválida ⇒ un reintento y después error (el llamador usa plantilla).
 * Registra cada intento en `llm_runs`.
 */
export async function callJson<T>(
  deps: LlmDeps,
  args: { purpose: LlmRunRecord["purpose"]; config: LlmCallConfig; system: string; user: string; schema: z.ZodType<T>; entityRef: Record<string, unknown>; validate?: (v: T) => string | null },
): Promise<LlmResult<T>> {
  let lastError = "sin intentos";
  let llmRunId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = { purpose: args.purpose, provider: deps.llm.provider, model: args.config.model, instructionsVersion: args.config.instructions_version, entityRef: args.entityRef };
    let out;
    try {
      out = await deps.llm.completeJson({ config: args.config, system: args.system, user: args.user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timeout = /timed? ?out/i.test(msg);
      llmRunId = await deps.recordRun({ ...base, status: timeout ? "timeout" : "error", error: msg.slice(0, 500) });
      return { ok: false, error: msg, llmRunId };
    }
    const tokens = { inputTokens: out.inputTokens, outputTokens: out.outputTokens, latencyMs: out.latencyMs };
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.content);
    } catch {
      lastError = "salida vacía o no JSON";
      llmRunId = await deps.recordRun({ ...base, ...tokens, status: "invalid", error: lastError, output: out.content.slice(0, 1000) });
      continue;
    }
    const v = args.schema.safeParse(parsed);
    const semantic = v.success && args.validate ? args.validate(v.data) : null;
    if (!v.success || semantic) {
      lastError = semantic ?? v.error!.message.slice(0, 300);
      llmRunId = await deps.recordRun({ ...base, ...tokens, status: "invalid", error: lastError, output: parsed });
      continue;
    }
    llmRunId = await deps.recordRun({ ...base, ...tokens, status: "ok", output: parsed });
    return { ok: true, value: v.data, llmRunId };
  }
  return { ok: false, error: lastError, llmRunId };
}
