// Recorrido real por HTTP: chat → borrador → confirmación → job → evaluación Jev real → incidente en /operacion.
// Uso: node scripts/e2e-walkthrough.mjs [baseUrl] [ruta-foto-opcional]
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3100";
const photo = process.argv[3];
const jar = new Map();

async function call(path, { method = "GET", json, form } = {}) {
  const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
  if (json) headers["content-type"] = "application/json";
  const t0 = Date.now();
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : form });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return { body, ms: Date.now() - t0 };
}

const lastAssistant = (d) => d.messages.filter((m) => m.role === "assistant").at(-1);
const show = (label, r) => console.log(`\n[${label}] ${r.ms}ms\n  asistente: ${lastAssistant(r.body)?.body}\n  ui: ${JSON.stringify(lastAssistant(r.body)?.ui)}  ficha: ${JSON.stringify(r.body.card)}`);

for (let i = 0; i < 60; i++) {
  try {
    await fetch(base + "/api/reportar/drafts?territory=montevideo");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let r = await call("/api/reportar/drafts", { method: "POST", json: { territorySlug: "montevideo" } });
const id = r.body.id;
console.log(`borrador ${id}\n  bienvenida: ${r.body.messages[0].body}`);

r = await call(`/api/reportar/drafts/${id}/messages`, { method: "POST", json: { clientMessageId: randomUUID(), body: "Hay bolsas de basura tapando la rampa frente al 1234 de 18 de Julio, no se puede pasar con la silla de ruedas" } });
show("mensaje 1", r);

if (photo) {
  const form = new FormData();
  form.set("file", new Blob([await readFile(photo)], { type: "image/jpeg" }), "foto.jpg");
  form.set("clientMessageId", randomUUID());
  r = await call(`/api/reportar/drafts/${id}/attachments`, { method: "POST", form });
  show("foto", r);
}

const proposal = r.body.messages.map((m) => m.ui).filter((u) => u?.kind === "propose_location").at(-1);
const point = proposal ?? { lon: -56.1894, lat: -34.9059, label: "18 de Julio 1234" };
console.log(`\nubicación ${proposal ? "propuesta por LLM+geocodificador" : "elegida en el mapa"}: ${point.label} (${point.lon}, ${point.lat})`);
r = await call(`/api/reportar/drafts/${id}/location`, { method: "POST", json: { lon: point.lon, lat: point.lat, source: proposal ? "geocoded" : "map", text: point.label } });
show("ubicación confirmada", r);

const key = randomUUID();
r = await call(`/api/reportar/drafts/${id}/confirm`, { method: "POST", json: { idempotencyKey: key } });
const again = await call(`/api/reportar/drafts/${id}/confirm`, { method: "POST", json: { idempotencyKey: key } });
console.log(`\nconfirmado: código ${r.body.publicCode} (reintento devuelve ${again.body.publicCode}) — ${r.body.tracking.statusLabel}`);

for (let i = 0; i < 30; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  r = await call(`/api/reportar/drafts/${id}`);
  if (r.body.tracking.processing === "done" || r.body.tracking.processing === "error") break;
}
console.log(`seguimiento: ${JSON.stringify(r.body.tracking)}`);

const operatorPassword = process.env.DEMO_OPERATOR_PASSWORD;
if (operatorPassword) {
  await call("/api/auth/login", { method: "POST", json: { username: "operador.montevideo", password: operatorPassword } });
  const list = await call("/api/operacion/incidents?territory=montevideo&sort=recent");
  const inc = list.body.incidents[0];
  console.log(`\noperación ve ${list.body.incidents.length} incidente(s); el más reciente:\n  ${inc.title} · prioridad ${inc.priorityBand} · ${inc.status} · ${inc.area?.name} · reportes ${inc.reportCount} · revisión ${JSON.stringify(inc.openReviewKinds)}`);
}
