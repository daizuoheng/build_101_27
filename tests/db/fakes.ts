// Dobles para tests de base: Jev y storage en memoria, CLARAMENTE simulados. La integración real se prueba con smoke-jev.
import type { Pool } from "pg";
import type { JevCall, JevClient } from "@/server/ai/jev/client";
import type { IntakeDeps } from "@/server/intake/orchestrator";
import type { StorageAdapter } from "@/server/storage/adapter";

const c = (choice: string, p = 0.97) => ({ type: "choice" as const, choice, confidence: 0.9, probabilities: { [choice]: p } });

export function fakeAnswers(over: Record<string, unknown> = {}) {
  return {
    intent: c("report"),
    applicability: c("applicable"),
    problem_type: c("bache"),
    severity: c("medium"),
    active_fire: c("no"),
    passage: c("partial"),
    accessibility: c("not_affected"),
    location_in_text: c("absent"),
    photo_quality: c("no_photo"),
    text_photo_consistency: c("not_evaluable"),
    fact_photo_shows_fire: { type: "noul", noul: 0.01 },
    fact_recurring_problem_claimed: { type: "noul", noul: 0.05 },
    ...over,
  };
}

/** Respuesta simulada de comparación: `match_<ref>` y los tres Noul de conflicto por candidato. */
export function fakeComparison(byRef: Record<string, { match: string; p?: number; object?: number; place?: number; time?: number }>) {
  const out: Record<string, unknown> = {};
  for (const [ref, x] of Object.entries(byRef)) {
    out[`match_${ref}`] = c(x.match, x.p ?? 0.95);
    out[`object_conflict_${ref}`] = { type: "noul", noul: x.object ?? 0.05 };
    out[`place_conflict_${ref}`] = { type: "noul", noul: x.place ?? 0.05 };
    out[`time_conflict_${ref}`] = { type: "noul", noul: x.time ?? 0.05 };
  }
  return out;
}

export function fakeJev(answers: (call: JevCall) => Record<string, unknown> = () => fakeAnswers()): JevClient & { calls: JevCall[] } {
  const jev = {
    calls: [] as JevCall[],
    async systemOne(call: JevCall) {
      jev.calls.push(call);
      return { data: { model: "fake-jev", answers: answers(call), usage: { input_tokens: 1, output_tokens: 1 } } as never, latencyMs: 1 };
    },
  };
  return jev;
}

export function memoryStorage(): StorageAdapter {
  const m = new Map<string, Buffer>();
  return { put: async (k, b) => void m.set(k, b), get: async (k) => m.get(k)! };
}

export function testDeps(pool: Pool, jev: JevClient = fakeJev()): IntakeDeps {
  return { pool, jev, llm: null, storage: memoryStorage() };
}

export async function territoryId(pool: Pool, slug = "montevideo"): Promise<string> {
  return (await pool.query<{ id: string }>("select id from territories where slug = $1", [slug])).rows[0].id;
}

export async function newSession(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("insert into citizen_sessions (token_hash) values (gen_random_uuid()::text) returning id");
  return rows[0].id;
}
