// Recorrido de la demo en vivo por HTTP, con LLM y Jev reales: ciudadano conversa y confirma → el incidente aparece
// en /operacion → la orden le llega sola a la cuadrilla de la demo en /unidad → Aceptar, Iniciar, Completar.
// Falla (exit 1) si algún acto no pasa. Requiere web + worker andando y la demo preparada:
//   pnpm cli seed-demo && pnpm cli reset-demo --yes && pnpm cli refresh-demo-positions --near -34.9058,-56.1882
// Uso: node --env-file=.env.local scripts/e2e-demo.mjs [baseUrl] [--photo ruta.jpg] [--text "relato"]
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const photo = flag("--photo");
const text = flag("--text") ?? "Hay un contenedor de basura prendido fuego en 18 de Julio y Ejido, sale mucho humo negro";
const base = args[0] ?? "http://localhost:3100";
const UNIT_USER = "unidad.cuadrilla-demo";
const DEMO_PASSWORD = "test"; // la de seeds/demo-users.ts

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, msg) {
  if (!cond) {
    console.error(`\n✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

/** Cliente con su propio frasco de cookies: ciudadano, operador y cuadrilla son tres navegadores distintos. */
function client() {
  const jar = new Map();
  return async function call(path, { method = "GET", json, form } = {}) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    if (json) headers["content-type"] = "application/json";
    const started = Date.now();
    const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : form });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(body)}`);
    return { body, ms: Date.now() - started };
  };
}

async function waitFor(label, fn, { timeoutMs = 90_000, everyMs = 1000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) {
      console.error(`\n✗ ${label}: no pasó en ${timeoutMs / 1000}s`);
      process.exit(1);
    }
    await sleep(everyMs);
  }
}

for (let i = 0; ; i++) {
  try {
    await fetch(base + "/api/health");
    break;
  } catch {
    if (i >= 60) throw new Error(`no responde ${base}: levantar web y worker antes de correr el recorrido`);
    await sleep(1000);
  }
}

// --- Acto 1: el ciudadano conversa con el agente y confirma el reporte ---
console.log(`\n[acto 1] ciudadano en ${base}/reportar/montevideo`);
const citizen = client();
let r = await citizen("/api/reportar/drafts", { method: "POST", json: { territorySlug: "montevideo" } });
const draftId = r.body.id;
// Reloj del servidor: el incidente de este reporte es el que se crea después de abrir el borrador.
const serverStart = Date.parse(r.body.messages[0].createdAt);
console.log(`  bienvenida: ${r.body.messages[0]?.body}`);

const lastUi = (d) => d.messages.filter((m) => m.role === "assistant").at(-1)?.ui ?? null;
const say = async (body) => {
  console.log(`  > ${body}`);
  r = await citizen(`/api/reportar/drafts/${draftId}/messages`, { method: "POST", json: { clientMessageId: randomUUID(), body } });
  const a = r.body.messages.filter((m) => m.role === "assistant").at(-1);
  console.log(`  < (${r.ms}ms) ${a?.body}  ui=${JSON.stringify(a?.ui)}`);
};

await say(text);
if (photo) {
  const form = new FormData();
  form.set("file", new Blob([await readFile(photo)], { type: "image/jpeg" }), "foto.jpg");
  form.set("clientMessageId", randomUUID());
  r = await citizen(`/api/reportar/drafts/${draftId}/attachments`, { method: "POST", form });
  console.log(`  < foto (${r.ms}ms) ui=${JSON.stringify(lastUi(r.body))}`);
}

// Ida y vuelta: respondemos lo que pida el agente hasta que la ficha quede lista para confirmar.
const fallbackPoint = { lon: -56.1871, lat: -34.9055, label: "18 de Julio y Ejido" };
let located = false;
for (let turn = 0; turn < 6; turn++) {
  const ui = lastUi(r.body);
  if (ui?.kind === "ready" || (located && r.body.card?.canConfirm)) break;
  if (ui?.kind === "propose_location" || ui?.kind === "ask_location" || !located) {
    const p = ui?.kind === "propose_location" ? ui : fallbackPoint;
    console.log(`  ubicación ${ui?.kind === "propose_location" ? "propuesta por el agente" : "marcada en el mapa"}: ${p.label} (${p.lat}, ${p.lon})`);
    r = await citizen(`/api/reportar/drafts/${draftId}/location`, {
      method: "POST",
      json: { lon: p.lon, lat: p.lat, source: ui?.kind === "propose_location" ? "geocoded" : "map", text: p.label },
    });
    located = true;
    console.log(`  < (${r.ms}ms) ${r.body.messages.filter((m) => m.role === "assistant").at(-1)?.body}  ui=${JSON.stringify(lastUi(r.body))}`);
    continue;
  }
  if (ui?.kind === "ask_evidence") {
    await say("Es un contenedor verde de la Intendencia, el fuego ya agarró las bolsas de al lado");
    continue;
  }
  break;
}
console.log(`  ficha: ${JSON.stringify(r.body.card)}`);

const key = randomUUID();
r = await citizen(`/api/reportar/drafts/${draftId}/confirm`, { method: "POST", json: { idempotencyKey: key } });
const confirmedAt = Date.now();
const publicCode = r.body.publicCode;
check(!!publicCode, `reporte confirmado con código ${publicCode} (${elapsed()})`);
const again = await citizen(`/api/reportar/drafts/${draftId}/confirm`, { method: "POST", json: { idempotencyKey: key } });
check(again.body.publicCode === publicCode, "reintentar la confirmación no duplica el reporte");

const tracking = await waitFor("procesamiento del reporte", async () => {
  const d = await citizen(`/api/reportar/drafts/${draftId}`);
  const t = d.body.tracking;
  return t.processing === "done" || t.processing === "error" ? t : null;
});
check(tracking.processing === "done", `worker procesó el reporte en ${((Date.now() - confirmedAt) / 1000).toFixed(1)}s: ${tracking.statusLabel}`);

// --- Acto 2: la consola de la Intendencia ve el incidente sin tocar nada ---
console.log(`\n[acto 2] operador en ${base}/operacion`);
const operator = client();
await operator("/api/auth/login", { method: "POST", json: { username: "operador.montevideo", password: DEMO_PASSWORD } });
const incident = await waitFor("incidente nuevo en /operacion (si el reporte se agrupó con uno anterior, correr reset-demo)", async () => {
  const list = await operator("/api/operacion/incidents?territory=montevideo&sort=recent");
  const created = list.body.incidents.filter((i) => Date.parse(i.createdAt) >= serverStart);
  if (created.length > 1) throw new Error(`hay ${created.length} incidentes nuevos: otro reporte entró durante el recorrido`);
  return created[0] ?? null;
});
console.log(`  ${incident.title} · ${incident.problemType?.name ?? incident.problemType?.slug ?? incident.problemType ?? "?"} · prioridad ${incident.priorityBand} · ${incident.status} · ${incident.area?.name} · reportes ${incident.reportCount}`);
check(!!incident.title && incident.title.length > 0, "el incidente tiene título");
check(incident.reportCount >= 1, "el incidente agrupa al menos un reporte");
const plan = await operator("/api/operacion/plan?territory=montevideo");
console.log(`  plan: ${JSON.stringify(plan.body).slice(0, 300)}…`);

// --- Acto 3: la orden le llega sola a la cuadrilla ---
console.log(`\n[acto 3] cuadrilla en ${base}/unidad (${UNIT_USER})`);
const unit = client();
await unit("/api/auth/login", { method: "POST", json: { username: UNIT_USER, password: DEMO_PASSWORD } });
const order = await waitFor("orden en /unidad", async () => {
  const inbox = await unit("/api/unidad/assignments");
  return inbox.body.assignments?.find((a) => a.incident.id === incident.id) ?? null;
});
const orderLatency = ((Date.now() - confirmedAt) / 1000).toFixed(1);
console.log(`  orden ${order.id} · ${order.status} · ${order.incident.title} · ${order.distanceM ?? "?"} m · acciones ${order.allowedActions.join("/")}`);
check(order.status === "offered", `la orden llegó a la cuadrilla ${orderLatency}s después de confirmar (sin tocar nada)`);
check(order.allowedActions.includes("accept"), "la cuadrilla puede aceptarla");
check(order.incident.citizenTexts.some((t) => t.includes(text)), "la orden trae el relato del ciudadano");

let current = order;
for (const action of ["accept", "start", "complete"]) {
  check(current.allowedActions.includes(action), `la cuadrilla puede ${action} (estado ${current.status}${current.reviewBlocked ? ", bloqueada por revisión" : ""})`);
  const res = await unit(`/api/unidad/assignments/${current.id}`, {
    method: "POST",
    json: { action, expectedVersion: current.version, idempotencyKey: randomUUID() },
  });
  const expected = { accept: "accepted", start: "in_progress", complete: "completed" }[action];
  check(res.body.result?.status === expected, `${action} → ${res.body.result?.status} (${res.ms}ms)`);
  const next = res.body.inbox.assignments?.find((a) => a.id === current.id);
  if (action === "complete") check(!next, "la orden completada sale de la bandeja");
  else check(!!next, `la orden sigue en la bandeja tras ${action}`);
  if (next) current = next;
}

const after = await waitFor("incidente resuelto en /operacion", async () => {
  const list = await operator("/api/operacion/incidents?territory=montevideo&sort=recent");
  const i = list.body.incidents.find((x) => x.id === incident.id);
  return i?.status === "resolved" ? i : null;
}, { timeoutMs: 20_000 });
check(after.status === "resolved", "el incidente quedó resuelto en /operacion");
const track = await citizen(`/api/reportar/drafts/${draftId}`);
check(track.body.tracking.incidentStatus === "resolved", `el ciudadano ve su reporte «${track.body.tracking.statusLabel}»`);
console.log(`\n✓ demo completa en ${elapsed()}`);
