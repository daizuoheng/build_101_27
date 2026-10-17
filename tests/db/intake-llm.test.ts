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

async function setupUnlocated(text = "Hay un pozo enorme en la calle") {
  const pool = await testDb();
  const t = await territoryId(pool);
  const s = await newSession(pool);
  const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
  await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: text }), pool);
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

  it("pin de corrección sin confirmar: otro mensaje lo vuelve a ofrecer; al confirmar, vuelve la ficha lista", async () => {
    const { pool, t, s, id } = await setup();
    let call = 0;
    const deps = { ...testDeps(pool, fakeJev()), llm: fakeLlm((u) => {
      const news = u.new_messages as { id: string }[];
      return call++ === 0
        ? { proposed_fields: { location_text: "Rivera y Soca" }, source_message_ids: [news[0].id] }
        : { proposed_fields: {}, source_message_ids: [] };
    }) };
    await runIntakeTurn(deps, id);
    await cacheGeocode(pool, t, "Rivera y Soca", { lon: -56.15, lat: -34.9, label: "Rivera y Soca" });
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "perdón, es en Rivera y Soca" }), pool);
    await runIntakeTurn(deps, id);

    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000003", body: "y además está lleno de agua" }), pool);
    await runIntakeTurn(deps, id);
    const again = await lastAssistant(pool, id);
    expect(again.ui).toEqual({ kind: "propose_location", lon: -56.15, lat: -34.9, label: "Rivera y Soca" });
    expect(again.body).toMatch(/Rivera y Soca/);

    await withTx((c) => setLocation(c, { reportId: id, sessionId: s, lon: -56.15, lat: -34.9, source: "geocoded", text: "Rivera y Soca" }), pool);
    await runIntakeTurn(deps, id);
    expect((await lastAssistant(pool, id)).ui).toEqual({ kind: "ready" });
    expect((await getReport(pool, id)).location_text).toBe("Rivera y Soca");
  });

  it("dirección corregida que no se encuentra ⇒ aviso + ficha lista, sin quedar en loop", async () => {
    const { pool, t, s, id } = await setup();
    const seen: number[] = [];
    const deps = { ...testDeps(pool, fakeJev()), llm: fakeLlm((u) => {
      const news = u.new_messages as { id: string }[];
      seen.push(news.length);
      return seen.length === 1
        ? { proposed_fields: { location_text: "Calle Inexistente 999" }, source_message_ids: [news[0].id] }
        : { proposed_fields: {}, source_message_ids: [] };
    }) };
    await runIntakeTurn(deps, id);
    const key = `${t}:${"Calle Inexistente 999, Montevideo, Uruguay".toLowerCase()}`;
    await pool.query("insert into geocode_cache (provider, query_norm, result) values ('nominatim', $1, $2)", [key, { hit: null }]);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "es en Calle Inexistente 999" }), pool);
    await runIntakeTurn(deps, id);

    const m = await lastAssistant(pool, id);
    expect(m.ui).toEqual({ kind: "ready" });
    expect(m.body).toMatch(/No pude ubicar «Calle Inexistente 999»/);
    expect(m.body).toMatch(/Revisá la ficha/);

    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000003", body: "gracias" }), pool);
    await runIntakeTurn(deps, id);
    expect(seen).toEqual([1, 1]); // la ficha lista reinicia la ventana: no se reenvían mensajes viejos
  });

  it("tras pedir la ubicación, el texto se trata como dirección aunque Jev la vea vaga", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    const s = await newSession(pool);
    const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: "hay un pozo en 18 de julio" }), pool);
    const vague = fakeJev(() => fakeAnswers({ location_in_text: choice("vague") }));
    const llm = fakeLlm((u) => {
      const msgs = u.messages as { id: string; text: string }[];
      const last = msgs.at(-1)!;
      return { address: last.text, source_message_ids: [last.id] };
    });
    const deps = { ...testDeps(pool, vague), llm };
    await runIntakeTurn(deps, id);
    expect((await lastAssistant(pool, id)).ui).toEqual({ kind: "ask_location" });
    expect(llm.calls).toBe(0);

    await cacheGeocode(pool, t, "18 de julio y ejido", { lon: -56.1868, lat: -34.9056, label: "18 de julio y ejido" });
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "18 de julio y ejido" }), pool);
    await runIntakeTurn(deps, id);
    expect(llm.calls).toBe(1);
    expect((await lastAssistant(pool, id)).ui).toEqual({ kind: "propose_location", lon: -56.1868, lat: -34.9056, label: "18 de julio y ejido" });
  });

  it("respuestas por texto (sin botones): «sí» confirma el pin, «no» pide otra dirección sin llamar a Jev", async () => {
    const { pool, t, s, id } = await setupUnlocated();
    const jev = fakeJev(() => fakeAnswers({ location_in_text: choice("precise") }));
    const llm = fakeLlm((u) => {
      const msgs = u.messages as { id: string; text: string }[];
      return { address: "18 de julio y ejido", source_message_ids: [msgs.at(-1)!.id] };
    });
    const deps = { ...testDeps(pool, jev), llm };
    await cacheGeocode(pool, t, "18 de julio y ejido", { lon: -56.1868, lat: -34.9056, label: "18 de julio y ejido" });
    await runIntakeTurn(deps, id);
    expect((await lastAssistant(pool, id)).ui).toMatchObject({ kind: "propose_location" });

    const calls = jev.calls;
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "No" }), pool);
    await runIntakeTurn(deps, id);
    expect(jev.calls).toBe(calls);
    expect(await lastAssistant(pool, id)).toMatchObject({ ui: { kind: "ask_location" }, body: expect.stringMatching(/dirección correcta/) });
    expect((await getReport(pool, id)).location_confirmed).toBe(false);
    expect((await getReport(pool, id)).description).toBe("Hay un pozo enorme en la calle"); // «No» no es relato

    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000003", body: "18 de julio y ejido" }), pool);
    await runIntakeTurn(deps, id);
    expect((await lastAssistant(pool, id)).ui).toMatchObject({ kind: "propose_location" });
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000004", body: "sí, es ahí" }), pool);
    await runIntakeTurn(deps, id);
    const r = await getReport(pool, id);
    expect(r).toMatchObject({ location_confirmed: true, location_source: "geocoded", location_text: "18 de julio y ejido" });
    expect((await lastAssistant(pool, id)).ui).toEqual({ kind: "ready" });
    // Ni la dirección escrita ni el «sí» quedan en la descripción; los mensajes siguen en la conversación.
    expect(r.description).toBe("Hay un pozo enorme en la calle");
    const msgs = await pool.query("select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id where c.report_id = $1 and m.role = 'citizen'", [id]);
    expect(msgs.rows[0].n).toBe(4);
  });

  it("«enviar» con la ficha lista envía el reporte; «sí, y además…» no", async () => {
    const { pool, s, id } = await setup();
    const deps = { ...testDeps(pool, fakeJev()), llm: fakeLlm(() => ({ proposed_fields: {}, source_message_ids: [] })) };
    await runIntakeTurn(deps, id);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "sí, y además está lleno de agua" }), pool);
    await runIntakeTurn(deps, id);
    expect((await getReport(pool, id)).status).toBe("draft");

    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000003", body: "Enviar" }), pool);
    await runIntakeTurn(deps, id);
    const r = await getReport(pool, id);
    expect(r.status).toBe("confirmed");
    expect(r.public_code).toMatch(/^[A-Z2-9]{6}$/);
    expect(r.description).toBe("Hay un pozo enorme en la calle\nsí, y además está lleno de agua");
    expect(await lastAssistant(pool, id)).toMatchObject({ ui: { kind: "confirmed", publicCode: r.public_code } });
    expect((await pool.query("select count(*)::int as n from jobs where kind = 'process_report'")).rows[0].n).toBe(1);
  });

  it("consulta por código: estado sin datos personales, código inexistente y tope por hora", async () => {
    const { pool, s, id } = await setup();
    const deps = testDeps(pool, fakeJev());
    await runIntakeTurn(deps, id);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000002", body: "enviar" }), pool);
    await runIntakeTurn(deps, id);
    const code = (await getReport(pool, id)).public_code!;

    // Otra persona, en otro navegador, consulta por el código.
    const t = await territoryId(pool);
    const other = await newSession(pool);
    const d2 = await withTx((c) => createDraft(c, { sessionId: other, territoryId: t }), pool);
    let n = 1;
    const ask = async (body: string) => {
      await withTx((c) => appendCitizenMessage(c, { reportId: d2, sessionId: other, clientMessageId: `msg-q000000${n++}`, body }), pool);
      await runIntakeTurn(deps, d2);
      return (await lastAssistant(pool, d2)).body as string;
    };
    expect(await ask(`¿cómo va el reporte ${code.toLowerCase()}?`)).toBe(`Reporte ${code}: recibido, pendiente de análisis.`);
    expect(await ask("estado de ZZZZ22")).toMatch(/No encontré un reporte con el código ZZZZ22/);
    expect((await getReport(pool, d2)).description).toBeNull(); // las consultas no son relato

    await pool.query(
      `insert into events (entity_type, entity_id, kind, actor_type, actor_id, data)
       select 'citizen_session', $1, 'status_lookup', 'citizen', $1, '{}' from generate_series(1, 10)`,
      [other],
    );
    expect(await ask(`estado de ${code}`)).toMatch(/muchas consultas/);
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
