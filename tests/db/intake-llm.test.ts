// Ramas de recepción con LLM (Tarea 13): repregunta y corrección, con fallback a plantilla. Jev y LLM son dobles simulados.
import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { withTx } from "@/server/db/tx";
import type { LlmClient } from "@/server/ai/llm/client";
import { appendCitizenMessage, createDraft, getReport, setLocation } from "@/server/intake/drafts";
import { runIntakeTurn } from "@/server/intake/orchestrator";
import { fakeAnswers, fakeJev, newSession, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

const POINT = { lon: -56.1645, lat: -34.9011 };
const choice = (c: string) => ({ type: "choice" as const, choice: c, confidence: 0.9, probabilities: { [c]: 0.97 } });

/** LLM falso: cada llamada recibe el payload del usuario ya parseado y devuelve el JSON a responder (o lanza). */
function fakeLlm(respond: (user: Record<string, unknown>) => object): LlmClient & { calls: number } {
  const llm = {
    provider: "fake",
    calls: 0,
    async completeJson({ user }: { user: string }) {
      llm.calls++;
      return { content: JSON.stringify(respond(JSON.parse(user))), latencyMs: 1 };
    },
  };
  return llm;
}

async function setup(text = "Hay un pozo enorme en la calle", locationText = "Rivera y Comercio") {
  const pool = await testDb();
  const t = await territoryId(pool);
  const s = await newSession(pool);
  const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
  await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: text }), pool);
  await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...POINT, source: "map", text: locationText }), pool);
  return { pool, t, s, id };
}

async function lastAssistant(pool: Awaited<ReturnType<typeof testDb>>, reportId: string) {
  const { rows } = await pool.query(
    `select m.body, m.origin, m.ui, m.llm_run_id from messages m join conversations c on c.id = m.conversation_id
     where c.report_id = $1 and m.role = 'assistant' order by m.seq desc limit 1`,
    [reportId],
  );
  return rows[0];
}

/** Precarga la caché del geocodificador para no salir a la red. */
async function cacheGeocode(pool: Awaited<ReturnType<typeof testDb>>, t: string, query: string, hit: { lon: number; lat: number; label: string }) {
  const key = `${t}:${`${query}, Montevideo, Uruguay`.trim().toLowerCase().replace(/\s+/g, " ")}`;
  await pool.query("insert into geocode_cache (provider, query_norm, result) values ('nominatim', $1, $2)", [key, { hit }]);
}

describe("recepción con LLM bajo demanda", () => {
  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool, { importAreas: true });
  });

  it("ask_evidence: la repregunta la redacta el LLM y cuenta como ronda", async () => {
    const { pool, id } = await setup();
    const jev = fakeJev(() => fakeAnswers({ photo_quality: choice("insufficient") }));
    const llm = fakeLlm((u) => ({ question: "¿Podés mandar una foto más cerca del pozo?", requested_field: u.requested_field }));
    await runIntakeTurn({ ...testDeps(pool, jev), llm }, id);

    const m = await lastAssistant(pool, id);
    expect(m).toMatchObject({ origin: "llm", body: "¿Podés mandar una foto más cerca del pozo?", ui: { kind: "ask_evidence", requestedField: "photo" } });
    expect(m.llm_run_id).toBeTruthy();
    expect((await getReport(pool, id)).clarification_rounds).toBe(1);
  });

  it("ask_evidence: si el LLM falla, plantilla ask_better_photo", async () => {
    const { pool, id } = await setup();
    const jev = fakeJev(() => fakeAnswers({ photo_quality: choice("insufficient") }));
    const llm: LlmClient = { provider: "fake", completeJson: async () => { throw new Error("proveedor caído"); } };
    await runIntakeTurn({ ...testDeps(pool, jev), llm }, id);

    const m = await lastAssistant(pool, id);
    expect(m.origin).toBe("template");
    expect(m.body).toMatch(/otra foto/);
    expect(m.ui).toEqual({ kind: "ask_evidence", requestedField: "photo" });
    const runs = await pool.query("select purpose, status from llm_runs");
    expect(runs.rows).toEqual([{ purpose: "clarify", status: "error" }]);
  });

  it("corrección de ubicación tras la ficha lista ⇒ pin propuesto; el borrador no cambia hasta que la persona confirma", async () => {
    const { pool, t, s, id } = await setup();
    const deps = { ...testDeps(pool, fakeJev()), llm: fakeLlm((u) => {
      const news = u.new_messages as { id: string }[];
      return { proposed_fields: { location_text: "Rivera y Soca" }, source_message_ids: [news[0].id] };
    }) };
    await runIntakeTurn(deps, id);
    expect((await lastAssistant(pool, id)).ui).toEqual({ kind: "ready" });
    expect(deps.llm.calls).toBe(0); // la ficha lista no necesita LLM

    await cacheGeocode(pool, t, "Rivera y Soca", { lon: -56.15, lat: -34.9, label: "Rivera y Soca" });
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "perdón, es en Rivera y Soca" }), pool);
    await runIntakeTurn(deps, id);

    const m = await lastAssistant(pool, id);
    expect(m.ui).toEqual({ kind: "propose_location", lon: -56.15, lat: -34.9, label: "Rivera y Soca" });
    expect(m.llm_run_id).toBeTruthy();
    const r = await getReport(pool, id);
    expect(r).toMatchObject({ location_text: "Rivera y Comercio", location_confirmed: true, lon: POINT.lon });
    const runs = await pool.query("select purpose, status from llm_runs");
    expect(runs.rows).toEqual([{ purpose: "interpret_correction", status: "ok" }]);
  });

  it("texto nuevo sin corrección de ubicación ⇒ ficha lista de nuevo", async () => {
    const { pool, s, id } = await setup();
    const deps = { ...testDeps(pool, fakeJev()), llm: fakeLlm(() => ({ proposed_fields: {}, source_message_ids: [] })) };
    await runIntakeTurn(deps, id);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "y además está lleno de agua" }), pool);
    await runIntakeTurn(deps, id);
    expect(deps.llm.calls).toBe(1);
    expect(await lastAssistant(pool, id)).toMatchObject({ origin: "template", ui: { kind: "ready" } });
  });

  it("corrección con fuente inventada ⇒ se descarta y vuelve la ficha lista (fallback)", async () => {
    const { pool, s, id } = await setup();
    const deps = { ...testDeps(pool, fakeJev()), llm: fakeLlm(() => ({ proposed_fields: { location_text: "Rivera y Soca" }, source_message_ids: ["no-existe"] })) };
    await runIntakeTurn(deps, id);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "es en Rivera y Soca" }), pool);
    await runIntakeTurn(deps, id);
    expect(await lastAssistant(pool, id)).toMatchObject({ origin: "template", ui: { kind: "ready" } });
    const runs = await pool.query("select status from llm_runs order by created_at");
    expect(runs.rows.map((r) => r.status)).toEqual(["invalid", "invalid"]);
  });

  it("sin LLM configurado, texto nuevo tras la ficha ⇒ plantilla", async () => {
    const { pool, s, id } = await setup();
    const deps = testDeps(pool, fakeJev());
    await runIntakeTurn(deps, id);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "es en Rivera y Soca" }), pool);
    await runIntakeTurn(deps, id);
    expect(await lastAssistant(pool, id)).toMatchObject({ origin: "template", ui: { kind: "ready" } });
  });
});
