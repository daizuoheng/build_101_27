import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { generateText, type TextInput } from "@/server/ai/llm/generate-text";
import { getActivePolicy } from "@/server/config/policies";
import { claimNext } from "@/server/jobs/queue";
import { enqueueTextgen, runTextgen, textInputs } from "@/server/pipeline/textgen";
import { fakeLlm, newSession, territoryId } from "./fakes";
import { resetDb, testDb } from "./setup";

async function incidentWithReport(pool: Pool): Promise<{ incidentId: string; reportId: string; territory: string }> {
  const territory = await territoryId(pool);
  const session = await newSession(pool);
  const rep = await pool.query<{ id: string }>(
    `insert into reports (citizen_session_id, territory_id, status, public_code, confirmed_revision, description, location, confirmed_at)
     values ($1, $2, 'confirmed', 'TXTGEN', 1, 'Pozo enorme frente al 2450 de Av. Italia', st_setsrid(st_makepoint(-56.15, -34.89), 4326)::geography, now())
     returning id`,
    [session, territory],
  );
  const inc = await pool.query<{ id: string }>(
    `insert into incidents (territory_id, problem_type_id, severity, location, location_text, priority_band, priority_breakdown)
     select $1, id, 'high', st_setsrid(st_makepoint(-56.15, -34.89), 4326)::geography, 'Av. Italia 2450', 'high', '{"rules": ["severity_high"]}'
     from problem_types where slug = 'bache' returning id`,
    [territory],
  );
  await pool.query("insert into report_incident_links (report_id, incident_id, origin) values ($1, $2, 'auto')", [rep.rows[0].id, inc.rows[0].id]);
  return { incidentId: inc.rows[0].id, reportId: rep.rows[0].id, territory };
}

/** Respuesta válida que cita la primera referencia del input. */
const citeFirst = ({ user }: { user: string }) => {
  const refs = JSON.parse(user.split("<referencias>\n")[1].split("\n</referencias>")[0]) as { id: string }[];
  return JSON.stringify({ body: "Bache en Av. Italia 2450", references: refs.slice(0, 1).map((r) => r.id) });
};

async function titleInput(pool: Pool, incidentId: string, revision = 1): Promise<TextInput> {
  const territory = await territoryId(pool);
  const reports = (await pool.query<{ id: string; description: string }>("select id, description from reports")).rows.map((r) => ({ id: r.id, text: r.description }));
  return { purpose: "title", territoryId: territory, entity: { type: "incident", id: incidentId, revision }, facts: { problem_type: "Bache", place: "Av. Italia 2450" }, references: reports };
}

const texts = (pool: Pool) =>
  pool.query<{ purpose: string; entity_revision: number; body: string; references: string[]; llm_run_id: string | null }>(
    `select purpose, entity_revision, body, "references", llm_run_id from generated_texts order by purpose, entity_revision`,
  );

describe("textos generados (textgen)", () => {
  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool, { importAreas: false });
  });

  it("cachea por (propósito, entidad, revisión): la misma revisión no vuelve a llamar al LLM, una nueva sí", async () => {
    const pool = await testDb();
    const { incidentId, reportId } = await incidentWithReport(pool);
    const llm = fakeLlm(citeFirst);

    const first = await generateText({ pool, llm }, await titleInput(pool, incidentId, 1));
    expect(first).toMatchObject({ source: "llm", body: "Bache en Av. Italia 2450", references: [reportId], discarded: false });
    const again = await generateText({ pool, llm }, await titleInput(pool, incidentId, 1));
    expect(again.source).toBe("cache");
    expect(llm.calls).toHaveLength(1);

    await generateText({ pool, llm }, await titleInput(pool, incidentId, 2));
    expect(llm.calls).toHaveLength(2);
    expect((await texts(pool)).rows.map((r) => r.entity_revision)).toEqual([1, 2]);
  });

  it("el job sobre una revisión vieja no llama al LLM ni persiste", async () => {
    const pool = await testDb();
    const { incidentId, territory } = await incidentWithReport(pool);
    await enqueueTextgen(pool, { incidentId, revision: 1, territoryId: territory });
    await pool.query("update incidents set revision = 2 where id = $1", [incidentId]);
    const job = (await claimNext(pool, "w", 60))!;
    expect(job).toMatchObject({ kind: "textgen", entity_id: incidentId, entity_revision: 1 });

    const llm = fakeLlm(citeFirst);
    expect(await runTextgen({ pool, llm }, job)).toEqual({ discarded: true, sources: {}, fallbacks: {} });
    expect(llm.calls).toHaveLength(0);
    expect((await texts(pool)).rows).toEqual([]);
  });

  it("si la revisión cambia mientras el LLM redacta, el texto se descarta", async () => {
    const pool = await testDb();
    const { incidentId, territory } = await incidentWithReport(pool);
    await enqueueTextgen(pool, { incidentId, revision: 1, territoryId: territory });
    const job = (await claimNext(pool, "w", 60))!;
    const llm = fakeLlm(async (call) => {
      await pool.query("update incidents set revision = 2 where id = $1", [incidentId]);
      return citeFirst(call);
    });
    const res = await runTextgen({ pool, llm }, job);
    expect(res.discarded).toBe(true);
    expect((await texts(pool)).rows).toEqual([]);
  });

  it("salida inválida dos veces ⇒ plantilla de respaldo, sin llm_run_id y con los dos intentos registrados", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    const llm = fakeLlm(() => "esto no es json");
    const res = await generateText({ pool, llm }, await titleInput(pool, incidentId));
    expect(res).toMatchObject({ source: "template", body: "Bache — Av. Italia 2450", references: [], llmRunId: null });
    expect(llm.calls).toHaveLength(2);
    const runs = await pool.query("select purpose, status from llm_runs");
    expect(runs.rows).toEqual([{ purpose: "title", status: "invalid" }, { purpose: "title", status: "invalid" }]);
    expect((await texts(pool)).rows[0]).toMatchObject({ body: "Bache — Av. Italia 2450", llm_run_id: null });
  });

  it("una referencia que no está en el input se rechaza (reintento y después plantilla)", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    const llm = fakeLlm(() => JSON.stringify({ body: "Bache en Av. Italia", references: ["00000000-0000-4000-8000-00000000dead"] }));
    const res = await generateText({ pool, llm }, await titleInput(pool, incidentId));
    expect(res.source).toBe("template");
    expect(res.error).toMatch(/referencias fuera del input/);
    const runs = await pool.query<{ error: string }>("select error from llm_runs");
    expect(runs.rows.every((r) => /referencias fuera del input/.test(r.error))).toBe(true);
  });

  it("un texto que promete despacho o tiempos de llegada se rechaza", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    const llm = fakeLlm(() => JSON.stringify({ body: "Una cuadrilla ya está en camino", references: [] }));
    const res = await generateText({ pool, llm }, await titleInput(pool, incidentId));
    expect(res.source).toBe("template");
    expect(res.error).toMatch(/prohibido por política/);
  });

  it("una plantilla cacheada se reemplaza cuando el LLM vuelve a responder bien", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    await generateText({ pool, llm: fakeLlm(() => "") }, await titleInput(pool, incidentId));
    const ok = await generateText({ pool, llm: fakeLlm(citeFirst) }, await titleInput(pool, incidentId));
    expect(ok.source).toBe("llm");
    const rows = (await texts(pool)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].llm_run_id).not.toBeNull();
  });

  it("una plantilla de respaldo que viola la política falla en vez de mostrarse y cachearse", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    await pool.query("update message_templates set body = 'Una cuadrilla ya está en camino a {{place}}' where key = 'textgen_title'");
    await expect(generateText({ pool, llm: fakeLlm(() => "") }, await titleInput(pool, incidentId))).rejects.toThrow(/plantilla 'textgen_title' inválida/);
    expect((await texts(pool)).rows).toEqual([]);
  });

  it("datos largos en la plantilla se recortan al máximo en vez de fallar", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    const input = await titleInput(pool, incidentId);
    input.facts.place = "Frente al edificio, del lado de la parada de ómnibus sobre 18 de Julio, pasando la farmacia de la esquina";
    const res = await generateText({ pool, llm: fakeLlm(() => "") }, input);
    expect(res.source).toBe("template");
    expect(res.body).toHaveLength(90);
    expect(res.body.endsWith("…")).toBe(true);
  });

  it("un dato ciudadano con una frase prohibida se omite en la plantilla", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    const input = await titleInput(pool, incidentId);
    input.facts.place = "esquina donde la cuadrilla está en camino";
    const res = await generateText({ pool, llm: null }, input);
    expect(res.body).toBe("Bache — [dato omitido]");
  });

  it("el recorte de la plantilla no parte emojis", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    const input = await titleInput(pool, incidentId);
    input.facts.place = "🚧".repeat(120);
    const res = await generateText({ pool, llm: null }, input);
    expect(Array.from(res.body)).toHaveLength(90);
    expect(res.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("si otro worker guardó un texto del LLM mientras este redactaba, devuelve el guardado y no el propio", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    const input = await titleInput(pool, incidentId);
    const other = await pool.query<{ id: string }>(
      "insert into llm_runs (purpose, provider, model, instructions_version, status) values ('title', 'otro', 'm', 'v', 'ok') returning id",
    );
    const llm = fakeLlm(async (call) => {
      await pool.query(
        `insert into generated_texts (purpose, entity_type, entity_id, entity_revision, body, llm_run_id) values ('title', 'incident', $1, 1, 'Guardado por otro worker', $2)`,
        [incidentId, other.rows[0].id],
      );
      return citeFirst(call);
    });
    const res = await generateText({ pool, llm }, input);
    expect(res).toMatchObject({ source: "cache", body: "Guardado por otro worker", llmRunId: other.rows[0].id, discarded: false });
    expect((await texts(pool)).rows).toHaveLength(1);
  });

  it("el resumen de respaldo conserva peligro activo, paso y accesibilidad", async () => {
    const pool = await testDb();
    const { incidentId, territory } = await incidentWithReport(pool);
    await pool.query("update incidents set active_hazard = true, passage = 'total' where id = $1", [incidentId]);
    await pool.query("update policy_versions set config = jsonb_set(config, '{enabled}', 'false') where kind = 'textgen'");
    await enqueueTextgen(pool, { incidentId, revision: 1, territoryId: territory });
    await runTextgen({ pool, llm: null }, (await claimNext(pool, "w", 60))!);
    const summary = (await texts(pool)).rows.find((r) => r.purpose === "summary")!;
    expect(summary.body).toContain("hay peligro activo");
    expect(summary.body).toContain("paso bloqueado");
  });

  it("sin cliente LLM, una plantilla cacheada se reutiliza sin re-renderizar", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    expect((await generateText({ pool, llm: null }, await titleInput(pool, incidentId))).source).toBe("template");
    expect((await generateText({ pool, llm: null }, await titleInput(pool, incidentId))).source).toBe("cache");
  });

  it("con textgen.enabled = false usa la plantilla sin llamar al LLM", async () => {
    const pool = await testDb();
    const { incidentId } = await incidentWithReport(pool);
    await pool.query("update policy_versions set config = jsonb_set(config, '{enabled}', 'false') where kind = 'textgen'");
    const llm = fakeLlm(citeFirst);
    const res = await generateText({ pool, llm }, await titleInput(pool, incidentId));
    expect(res).toMatchObject({ source: "template", error: "textgen deshabilitado por política" });
    expect(llm.calls).toHaveLength(0);
  });

  it("el handler deja título, resumen y explicación; la explicación solo cita códigos de motivo del input", async () => {
    const pool = await testDb();
    const { incidentId, territory } = await incidentWithReport(pool);
    await enqueueTextgen(pool, { incidentId, revision: 1, territoryId: territory });
    const job = (await claimNext(pool, "w", 60))!;
    const res = await runTextgen({ pool, llm: fakeLlm(citeFirst) }, job);
    expect(res).toEqual({ discarded: false, sources: { title: "llm", summary: "llm", explain_priority: "llm" }, fallbacks: {} });
    const rows = (await texts(pool)).rows;
    expect(rows.map((r) => r.purpose)).toEqual(["explain_priority", "summary", "title"]);
    expect(rows[0].references).toEqual(["severity_high"]);
  });

  it("los hechos usan las etiquetas de la política y no incluyen estado ni despacho", async () => {
    const pool = await testDb();
    const { incidentId, territory } = await incidentWithReport(pool);
    const policy = (await getActivePolicy(pool, territory, "textgen")).config;
    const inc = { id: incidentId, territory_id: territory, revision: 1, type_name: "Bache", area_name: null, location_text: "Av. Italia 2450",
      severity: "high", active_hazard: false, passage: "partial", accessibility: "not_affected", priority_band: "high",
      priority_breakdown: { rules: ["severity_high"], promoted_by_age: true }, report_count: 2 };
    const inputs = textInputs(inc, [], policy);
    expect(inputs.summary.facts).toMatchObject({ severity: "alta", passage: "parcialmente obstruido", report_count: 2 });
    expect(inputs.explain_priority.facts.reasons).toEqual(["severidad alta", "antigüedad sin atender"]);
    expect(JSON.stringify(inputs)).not.toMatch(/status|assign|dispatch/);
  });
});
