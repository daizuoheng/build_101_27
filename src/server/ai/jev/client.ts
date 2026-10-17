import { APITimeoutError, APIError, TypeSafeClient, type ContentValue, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import type { AiError } from "@/shared/contracts/evaluation";

export type JevCall = {
  model: string;
  state: { [key: string]: ContentValue };
  questions: Questions;
  withImages: boolean;
  timeoutMs: number;
};

export type JevResponse = { data: SystemOneResult<Questions>; requestId?: string; latencyMs: number };

/** Puerto hacia Jev: los tests unitarios inyectan uno falso; en ejecución es siempre la API real. */
export interface JevClient {
  systemOne(call: JevCall): Promise<JevResponse>;
}

let shared: TypeSafeClient | null = null;

export function createJevClient(): JevClient {
  return {
    async systemOne(call) {
      // El worker reintenta con backoff propio; el SDK hace a lo sumo un reintento inmediato.
      shared ??= new TypeSafeClient({ retry: { maxRetries: 1 }, logLevel: "error" });
      const t0 = Date.now();
      const res = await shared
        .systemOne(
          { model: call.model, state: call.state, questions: call.questions },
          {
            timeout: call.timeoutMs,
            headers: call.withImages ? { "TypeSafe-Danger-Zone-Images": "true" } : undefined,
          },
        )
        .withResponse();
      return { data: res.data, requestId: res.requestId, latencyMs: Date.now() - t0 };
    },
  };
}

export function toAiError(err: unknown): AiError {
  if (err instanceof APITimeoutError) return { kind: "timeout", message: `Jev no respondió en ${err.timeoutMs} ms` };
  if (err instanceof APIError) return { kind: "provider", message: `Jev ${err.status}: ${JSON.stringify(err.body).slice(0, 500)}` };
  return { kind: "provider", message: err instanceof Error ? err.message : String(err) };
}
