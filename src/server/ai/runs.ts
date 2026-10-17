import type { Db } from "../db/pool";

export type AiRunRecord = {
  purpose: "evaluate" | "compare" | "assess";
  provider: string;
  modelRequested: string;
  modelReturned?: string;
  requestId?: string;
  inputRefs: Record<string, unknown>;
  request: unknown; // sin bytes: los assets se serializan como su referencia
  response?: unknown;
  usage?: unknown;
  latencyMs?: number;
  status: "ok" | "error" | "timeout" | "invalid";
  error?: string;
};

export async function recordAiRun(db: Db, r: AiRunRecord): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into ai_runs (purpose, provider, model_requested, model_returned, request_id, input_refs, request, response, usage, latency_ms, status, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [
      r.purpose, r.provider, r.modelRequested, r.modelReturned ?? null, r.requestId ?? null, r.inputRefs,
      JSON.stringify(r.request), r.response === undefined ? null : JSON.stringify(r.response),
      r.usage === undefined ? null : JSON.stringify(r.usage), r.latencyMs ?? null, r.status, r.error ?? null,
    ],
  );
  return rows[0].id;
}

export type LlmRunRecord = {
  purpose: "extract_address" | "clarify" | "interpret_correction" | "title" | "summary" | "explain";
  provider: string;
  model: string;
  instructionsVersion: string;
  entityRef: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  status: "ok" | "error" | "timeout" | "invalid";
  error?: string;
  output?: unknown;
};

export async function recordLlmRun(db: Db, r: LlmRunRecord): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into llm_runs (purpose, provider, model, instructions_version, entity_ref, input_tokens, output_tokens, latency_ms, status, error, output)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [
      r.purpose, r.provider, r.model, r.instructionsVersion, r.entityRef, r.inputTokens ?? null, r.outputTokens ?? null,
      r.latencyMs ?? null, r.status, r.error ?? null, r.output === undefined ? null : JSON.stringify(r.output),
    ],
  );
  return rows[0].id;
}
