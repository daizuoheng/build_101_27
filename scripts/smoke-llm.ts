// Prueba REAL de textos generados contra el LLM configurado (DeepSeek). No crea incidentes ni cachea:
// redacta con draftText sobre tres incidentes de ejemplo y registra cada intento en llm_runs.
// La política es la del seed (la que se publica), validada con el mismo esquema que usa el pipeline.
import { policies } from "../seeds/policies";
import { getPool } from "../src/server/db/pool";
import { TextgenPolicy } from "../src/server/config/policies";
import { createLlmClient } from "../src/server/ai/llm/client";
import { draftText } from "../src/server/ai/llm/generate-text";
import { textInputs } from "../src/server/pipeline/textgen";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const examples = [
  {
    name: "contenedor-fuego",
    incident: { type_name: "Contenedor prendido fuego", area_name: "CORDON", location_text: "8 de Octubre y Garibaldi", severity: "high", active_hazard: true,
      passage: "partial", accessibility: "undetermined", priority_band: "high", priority_breakdown: { rules: ["severity_high", "active_hazard"] }, report_count: 2 },
    reports: [
      { id: id(101), text: "Se está prendiendo fuego el contenedor de 8 de Octubre y Garibaldi, sale humo negro" },
      { id: id(102), text: "Hay un contenedor con llamas en la esquina de Garibaldi, el humo llega a las casas" },
    ],
  },
  {
    name: "bache",
    incident: { type_name: "Bache", area_name: "LA BLANQUEADA", location_text: "Av. Italia 2450", severity: "medium", active_hazard: false,
      passage: "partial", accessibility: "not_affected", priority_band: "medium", priority_breakdown: { rules: ["severity_medium"] }, report_count: 1 },
    reports: [{ id: id(201), text: "Pozo enorme en la calle frente al 2450 de Av. Italia, casi rompo la rueda" }],
  },
  {
    name: "rampa-obstruida",
    incident: { type_name: "Accesibilidad obstruida", area_name: "CENTRO", location_text: "Rivera y Comercio", severity: "low", active_hazard: false,
      passage: "none", accessibility: "affected", priority_band: "high", priority_breakdown: { rules: ["accessibility_affected"] }, report_count: 3 },
    reports: [
      { id: id(301), text: "Hay bolsas de basura tapando la rampa en Rivera y Comercio, no se puede pasar con la silla de ruedas" },
      { id: id(302), text: "La rampa de la esquina sigue tapada desde hace días" },
      { id: id(303), text: "Otra vez la rampa bloqueada con bolsas, mi madre no pudo cruzar" },
    ],
  },
  {
    // Baja promovida a media por antigüedad (sin reglas de riesgo), en una calle que empieza con «Camino».
    name: "basura-antigua-camino",
    incident: { type_name: "Basura acumulada", area_name: "UNION", location_text: "Camino Maldonado 5600", severity: "low", active_hazard: false,
      passage: "none", accessibility: "not_affected", priority_band: "medium", priority_breakdown: { rules: [], promoted_by_age: true }, report_count: 1 },
    reports: [{ id: id(401), text: "Hace una semana que no levantan la basura en Camino Maldonado 5600, ya hay bolsas rotas en la vereda" }],
  },
];

export async function smokeLlm(): Promise<number> {
  const llm = createLlmClient();
  if (!llm) {
    console.error("Faltan LLM_API_KEY / LLM_BASE_URL: smoke-llm queda bloqueado (no se simula).");
    return 2;
  }
  const pool = getPool();
  const t = await pool.query<{ id: string }>("select id from territories where slug = 'montevideo'");
  if (!t.rows[0]) {
    console.error("Correr primero `pnpm cli seed`.");
    return 2;
  }
  const policy = TextgenPolicy.parse(policies.textgen);
  console.log(`modelo ${policy.model} · ${policy.instructions_version} · proveedor ${llm.provider}\n`);
  let fallbacks = 0;
  for (const [i, ex] of examples.entries()) {
    const inc = { id: id(i + 1), territory_id: t.rows[0].id, revision: 1, ...ex.incident };
    const inputs = textInputs(inc, ex.reports, policy);
    console.log(`## ${ex.name}`);
    for (const input of Object.values(inputs)) {
      const t0 = Date.now();
      const r = await draftText({ db: pool, llm }, policy, input);
      if (r.source !== "llm") fallbacks++;
      console.log(`- ${input.purpose} [${r.source}, ${Date.now() - t0} ms]: ${r.body}`);
      console.log(`  referencias: ${JSON.stringify(r.references)}${r.error ? ` · error: ${r.error}` : ""}`);
    }
    console.log("");
  }
  console.log(fallbacks ? `${fallbacks} texto(s) cayeron a plantilla` : "todos los textos vinieron del LLM y validaron");
  return fallbacks ? 1 : 0;
}
