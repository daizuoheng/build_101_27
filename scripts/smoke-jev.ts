// Prueba REAL contra la API de Jev con casos del piloto. Escribe respuestas crudas en tests/fixtures/jev/responses/.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getPool } from "../src/server/db/pool";
import { getActiveCatalog } from "../src/server/config/catalog";
import { getActivePolicy } from "../src/server/config/policies";
import { createJevClient } from "../src/server/ai/jev/client";
import { evaluateReport } from "../src/server/ai/jev/evaluate-report";
import { recordAiRun, type AiRunRecord } from "../src/server/ai/runs";
import { normalizeForJev } from "../src/server/storage/normalize-image";
import { chosenProbability } from "../src/server/ai/jev/thresholds";

type Case = { name: string; texts: string[]; photo?: string; expect: Record<string, string> };

const cases: Case[] = [
  { name: "rampa-texto", texts: ["Hay bolsas de basura tapando la rampa en Rivera y Comercio, no se puede pasar con la silla de ruedas"], expect: { problem_type: "accesibilidad_obstruida", accessibility: "affected", location_in_text: "precise" } },
  { name: "fuego-texto", texts: ["Se está prendiendo fuego el contenedor de 8 de Octubre y Garibaldi, sale humo negro"], expect: { problem_type: "contenedor_fuego", active_fire: "yes" } },
  { name: "quemado-foto", texts: ["El contenedor de la esquina amaneció todo quemado, está derretido"], photo: "contenedor-quemado.jpg", expect: { problem_type: "contenedor_danado", active_fire: "no", photo_quality: "useful" } },
  { name: "quemado-foto-dice-fuego", texts: ["Hay un contenedor prendido fuego ahora mismo, vengan rápido!!"], photo: "contenedor-quemado.jpg", expect: { text_photo_consistency: "contradiction" } },
  { name: "bache-foto", texts: ["Pozo enorme en la calle frente al 2450 de Av. Italia, casi rompo la rueda"], photo: "bache.jpg", expect: { problem_type: "bache", location_in_text: "precise", photo_quality: "useful" } },
  { name: "basura-foto-sin-lugar", texts: ["mirá cómo dejaron la basura"], photo: "basura.jpg", expect: { problem_type: "basura_acumulada", location_in_text: "absent" } },
  { name: "ajeno", texts: ["hola buen día, ¿a qué hora abre la intendencia?"], expect: { intent: "other" } },
  { name: "consulta-estado", texts: ["¿ya mandaron a alguien por el bache que reporté ayer?"], expect: { intent: "status_query" } },
  { name: "vago", texts: ["en mi barrio hay un problema"], expect: { applicability: "insufficient", location_in_text: "vague" } },
];

export async function smokeJev(): Promise<number> {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("Falta TYPESAFE_API_KEY: smoke-jev queda bloqueado (no se simula).");
    return 2;
  }
  const pool = getPool();
  const t = await pool.query<{ id: string }>("select id from territories where slug = 'montevideo'");
  if (!t.rows[0]) {
    console.error("Correr primero `pnpm cli seed`.");
    return 2;
  }
  const territoryId = t.rows[0].id;
  const policy = await getActivePolicy(pool, territoryId, "evaluation");
  const catalog = await getActiveCatalog(pool, territoryId);
  const jev = createJevClient();
  await mkdir("tests/fixtures/jev/responses", { recursive: true });

  let hits = 0;
  let total = 0;
  for (const c of cases) {
    const images = c.photo
      ? [{ attachmentId: `photo-${c.name}`, ...(await normalizeForJev(await readFile(`tests/fixtures/jev/photos/${c.photo}`))) }]
      : [];
    let raw: AiRunRecord | null = null;
    const res = await evaluateReport(
      {
        reportId: `smoke-${c.name}`,
        reportRevision: 1,
        messages: c.texts.map((body, i) => ({ id: `m${i + 1}`, body, createdAt: new Date().toISOString() })),
        images: images.map((i) => ({ attachmentId: i.attachmentId, bytes: i.bytes, format: i.format })),
        location: { confirmed: false, text: null, areaName: null },
        catalog: catalog.types,
        catalogHash: catalog.hash,
        policy,
      },
      { jev, recordRun: async (run) => ((raw = run), recordAiRun(pool, run)) },
    );
    const r = raw as AiRunRecord | null;
    await writeFile(`tests/fixtures/jev/responses/${c.name}.json`, JSON.stringify({ case: c, run: { ...r, request: undefined } }, null, 2));
    if (!res.ok) {
      console.log(`✗ ${c.name}: ${res.error.kind} ${res.error.message}`);
      continue;
    }
    const answers = res.value.answers as Record<string, { choice?: string; probabilities?: Record<string, number> }>;
    const checks = Object.entries(c.expect).map(([k, want]) => {
      const a = answers[k];
      const ok = a?.choice === want;
      total++;
      if (ok) hits++;
      return `${ok ? "✓" : "✗"} ${k}=${a?.choice}(${a ? chosenProbability(a as never).toFixed(2) : "-"})${ok ? "" : ` esperado ${want}`}`;
    });
    console.log(`${c.name} [${r?.modelReturned} ${r?.latencyMs}ms${c.photo ? " +foto" : ""}] review=${res.value.reviewReasons.join(",") || "-"}\n   ${checks.join("  ")}`);
  }
  console.log(`\naciertos: ${hits}/${total}`);
  return 0;
}
