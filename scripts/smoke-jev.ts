// Prueba REAL contra la API de Jev con casos del piloto. Escribe respuestas crudas en tests/fixtures/jev/responses/.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import sharp from "sharp";
import { getPool } from "../src/server/db/pool";
import { getActiveCatalog } from "../src/server/config/catalog";
import { getActivePolicy } from "../src/server/config/policies";
import { createJevClient, type JevClient } from "../src/server/ai/jev/client";
import { compareCandidates } from "../src/server/ai/jev/compare-candidates";
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

// Pares de agrupación: reporte nuevo contra candidatos cercanos. `crop` simula otra toma de la misma foto.
type Side = { texts: string[]; photo?: string; crop?: "left" | "right" };
type Pair = { name: string; report: Side; candidates: (Side & { category: string; distanceM: number; hoursAgo: number })[]; expect: { verdict: string; match: string[] } };

const pairs: Pair[] = [
  {
    name: "mismo-bache-dos-textos",
    report: { texts: ["Pozo enorme en la calle frente al 2450 de Av. Italia, casi rompo la rueda"], photo: "bache.jpg", crop: "left" },
    candidates: [{ category: "Bache", distanceM: 6, hoursAgo: 20, texts: ["Hay un bache muy grande en Avenida Italia casi Comercio, a la altura del 2450, ojo con las motos"], photo: "bache.jpg", crop: "right" }],
    expect: { verdict: "link", match: ["same_incident"] },
  },
  {
    name: "bache-vs-basura-cercanos",
    report: { texts: ["Pozo enorme en la calle frente al 2450 de Av. Italia, casi rompo la rueda"], photo: "bache.jpg" },
    candidates: [{ category: "Basura acumulada", distanceM: 12, hoursAgo: 6, texts: ["Bolsas de basura tiradas al lado del contenedor en Av. Italia, hace días que no levantan"], photo: "basura.jpg" }],
    expect: { verdict: "create", match: ["different_incident"] },
  },
  {
    name: "ambiguo-sin-detalle",
    report: { texts: ["acá en la esquina hay un problema en la calle, está feo"] },
    candidates: [{ category: "Bache", distanceM: 15, hoursAgo: 30, texts: ["Pozo enorme en la calle frente al 2450 de Av. Italia, casi rompo la rueda"], photo: "bache.jpg" }],
    expect: { verdict: "review", match: ["uncertain"] },
  },
  {
    name: "dos-candidatos-elige-el-bache",
    report: { texts: ["Hay un pozo en el asfalto frente al 2450 de Av. Italia, se llena de agua"], photo: "bache.jpg", crop: "left" },
    candidates: [
      { category: "Basura acumulada", distanceM: 8, hoursAgo: 4, texts: ["Basura desparramada en la vereda de Av. Italia al 2400"], photo: "basura.jpg" },
      { category: "Bache", distanceM: 11, hoursAgo: 26, texts: ["Bache grande sobre Av. Italia a la altura del 2450, cuidado"], photo: "bache.jpg", crop: "right" },
    ],
    expect: { verdict: "link", match: ["different_incident", "same_incident"] },
  },
  {
    name: "fuego-nuevo-vs-quemado-ayer",
    report: { texts: ["Se está prendiendo fuego el contenedor de 8 de Octubre y Garibaldi ahora mismo, sale humo negro"] },
    candidates: [{ category: "Contenedor dañado", distanceM: 5, hoursAgo: 48, texts: ["El contenedor de 8 de Octubre y Garibaldi amaneció todo quemado, está derretido"], photo: "contenedor-quemado.jpg" }],
    expect: { verdict: "review", match: ["different_incident", "uncertain"] },
  },
];

async function photoFor(side: Side, ref: string) {
  if (!side.photo) return [];
  let bytes = await readFile(`tests/fixtures/jev/photos/${side.photo}`);
  if (side.crop) {
    const meta = await sharp(bytes).rotate().metadata();
    const w = Math.round(meta.width! * 0.8);
    const h = Math.round(meta.height! * 0.85);
    bytes = await sharp(bytes).rotate().extract({ left: side.crop === "left" ? 0 : meta.width! - w, top: side.crop === "left" ? 0 : meta.height! - h, width: w, height: h }).jpeg().toBuffer();
  }
  const n = await normalizeForJev(bytes);
  return [{ attachmentId: ref, bytes: n.bytes, format: n.format }];
}

async function smokeCompare(pool: Pool, territoryId: string, jev: JevClient): Promise<{ hits: number; total: number }> {
  const policy = await getActivePolicy(pool, territoryId, "grouping");
  let hits = 0;
  let total = 0;
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
  const msgs = (texts: string[], when: string) => texts.map((body, i) => ({ id: `m${i + 1}`, body, createdAt: when }));
  for (const p of pairs) {
    let raw: AiRunRecord | null = null;
    const res = await compareCandidates(
      {
        reportId: `smoke-${p.name}`,
        reportRevision: 1,
        report: { confirmedAt: at(0), messages: msgs(p.report.texts, at(0)), images: await photoFor(p.report, "new-photo"), location: { text: null, areaName: null } },
        candidates: await Promise.all(
          p.candidates.map(async (c, i) => ({
            incidentId: `incident-${i + 1}`,
            distanceM: c.distanceM,
            summary: { category: c.category, status: "open", firstReportedAt: at(c.hoursAgo), reportCount: 1 },
            evidence: { reports: [{ reportId: `report-${i + 1}`, confirmedAt: at(c.hoursAgo), messages: msgs(c.texts, at(c.hoursAgo)), images: await photoFor(c, `cand-${i + 1}-photo`) }] },
          })),
        ),
        truncated: false,
        policy,
      },
      { jev, recordRun: async (run) => ((raw = run), recordAiRun(pool, run)) },
    );
    const r = raw as AiRunRecord | null;
    await writeFile(`tests/fixtures/jev/responses/compare-${p.name}.json`, JSON.stringify({ pair: p, run: { ...r, request: undefined } }, null, 2));
    if (!res.ok) {
      console.log(`✗ ${p.name}: ${res.error.kind} ${res.error.message}`);
      continue;
    }
    const v = res.value;
    total += 1 + v.perCandidate.length;
    const okVerdict = v.verdict.kind === p.expect.verdict;
    if (okVerdict) hits++;
    const lines = v.perCandidate.map((c, i) => {
      const want = p.expect.match[i];
      const ok = c.match.choice === want || (p.expect.verdict === "review" && p.expect.match.includes(c.match.choice));
      if (ok) hits++;
      const probs = Object.entries(c.match.probabilities).map(([k, x]) => `${k.split("_")[0]}=${x.toFixed(2)}`).join(" ");
      const conf = Object.entries(c.conflicts).map(([k, x]) => `${k}=${x.toFixed(2)}`).join(" ");
      return `${ok ? "✓" : "✗"} ${c.ref} ${c.match.choice} [${probs}] conflictos ${conf}${ok ? "" : ` esperado ${want}`}`;
    });
    console.log(`${p.name} [${r?.modelReturned} ${r?.latencyMs}ms] ${okVerdict ? "✓" : "✗"} decisión=${v.verdict.kind} (${v.verdict.reasons.join(",")})${okVerdict ? "" : ` esperado ${p.expect.verdict}`}\n   ${lines.join("\n   ")}`);
  }
  return { hits, total };
}

export async function smokeJev(args: Record<string, string> = {}): Promise<number> {
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

  if (args.only === "compare") {
    const r = await smokeCompare(pool, territoryId, jev);
    console.log(`\nagrupación: ${r.hits}/${r.total}`);
    return 0;
  }

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
  if (args.only !== "evaluate") {
    console.log("\n— agrupación —");
    const r = await smokeCompare(pool, territoryId, jev);
    console.log(`\nagrupación: ${r.hits}/${r.total}`);
  }
  return 0;
}
