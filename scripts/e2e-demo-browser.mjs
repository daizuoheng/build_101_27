// La demo en vivo en un navegador real, tal como se ve en el escenario: tres ventanas (ciudadano en el celular,
// consola de la Intendencia, celular de la cuadrilla). /operacion y /unidad se abren ANTES del reporte y no se
// recargan nunca: el incidente y la orden tienen que aparecer solos. Guarda capturas de cada acto.
// Requiere web + worker andando, la demo recién reseteada (ver scripts/e2e-demo.mjs; un reporte que se agrupa con
// un incidente anterior no suma a la bandeja y el acto 2 falla) y Chrome instalado.
// Uso: NODE_PATH=<dir con playwright-core> node --env-file=.env.local scripts/e2e-demo-browser.mjs [baseUrl] [--out dir] [--headed]
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const headed = args.includes("--headed") ? (args.splice(args.indexOf("--headed"), 1), true) : false;
const out = flag("--out") ?? "e2e-shots";
const base = args[0] ?? "http://localhost:3100";
if (!process.env.DEMO_OPERATOR_PASSWORD || !process.env.DEMO_UNIT_PASSWORD) throw new Error("faltan DEMO_OPERATOR_PASSWORD / DEMO_UNIT_PASSWORD");
const text = "Hay un contenedor de basura prendido fuego en 18 de Julio y Ejido, sale mucho humo negro";
await mkdir(out, { recursive: true });

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const errors = [];
function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`  ✓ ${msg} (${elapsed()})`);
}

const browser = await chromium.launch({ channel: "chrome", headless: !headed });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "es-UY" };
const watch = (page, who) => {
  page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${who} console: ${m.text()}`));
};

async function login(page, username, password) {
  await page.goto(`${base}/login`);
  await page.getByLabel("Usuario").fill(username);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

let failed = false;
try {
  // Pantallas de la Intendencia y de la cuadrilla abiertas antes de que llegue el reporte.
  const opsCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es-UY" });
  const ops = await opsCtx.newPage();
  watch(ops, "operacion");
  await login(ops, "operador.montevideo", process.env.DEMO_OPERATOR_PASSWORD);
  await ops.goto(`${base}/operacion?territory=montevideo`);
  await ops.getByRole("region", { name: "Resumen" }).waitFor({ timeout: 30_000 });
  // Total de la bandeja ("Bandeja priorizada (N de M)"); el texto del tipo también aparece en el filtro.
  const opsTotal = () => ops.evaluate(() => Number(/Bandeja priorizada \(\d+ de (\d+)\)/i.exec(document.body.innerText)?.[1] ?? -1));
  await ops.waitForFunction(() => /Bandeja priorizada \(\d+ de \d+\)/i.test(document.body.innerText), null, { timeout: 30_000 });
  const opsBefore = await opsTotal();

  const unitCtx = await browser.newContext({ ...phone, geolocation: { latitude: -34.9058, longitude: -56.1882 }, permissions: ["geolocation"] });
  const unit = await unitCtx.newPage();
  watch(unit, "unidad");
  await login(unit, "unidad.cuadrilla-demo", process.env.DEMO_UNIT_PASSWORD);
  await unit.goto(`${base}/unidad`);
  await unit.getByText("No tenés órdenes activas").waitFor({ timeout: 30_000 });
  check(true, "consola y bandeja abiertas, la cuadrilla sin órdenes");
  await ops.screenshot({ path: `${out}/0-operacion-antes.png` });
  await unit.screenshot({ path: `${out}/0-unidad-antes.png` });

  // --- Acto 1: ciudadano ---
  console.log("\n[acto 1] ciudadano");
  const citizenCtx = await browser.newContext(phone);
  const citizen = await citizenCtx.newPage();
  watch(citizen, "reportar");
  await citizen.goto(`${base}/reportar/montevideo`);
  const input = citizen.locator("textarea, input[type=text]").last();
  await input.fill(text);
  await citizen.getByRole("button", { name: "Enviar mensaje" }).click();
  // El agente propone la dirección que entendió; la persona la confirma con el botón.
  // Solo los chips de "Respuestas sugeridas": el botón de ubicación del compositor está siempre visible.
  const replies = citizen.getByRole("group", { name: "Respuestas sugeridas" }).last();
  const yes = replies.getByRole("button", { name: "Sí, es ahí" });
  const askLoc = replies.getByRole("button", { name: "Enviar mi ubicación" });
  await yes.or(askLoc).first().waitFor({ timeout: 60_000 });
  if (await yes.isVisible()) await yes.click();
  else {
    await citizenCtx.grantPermissions(["geolocation"]);
    await citizenCtx.setGeolocation({ latitude: -34.9055, longitude: -56.1871 });
    await askLoc.click();
  }
  const send = citizen.getByRole("button", { name: "Enviar reporte" });
  await send.waitFor({ timeout: 60_000 });
  await citizen.screenshot({ path: `${out}/1-ciudadano-ficha.png`, fullPage: true });
  await send.click();
  const confirmedAt = Date.now();
  await citizen.getByRole("region", { name: "Estado del reporte" }).waitFor({ timeout: 30_000 });
  check(true, "reporte enviado desde el chat");
  await citizen.screenshot({ path: `${out}/1-ciudadano-enviado.png`, fullPage: true });

  // --- Acto 2: consola, sin recargar ---
  console.log("\n[acto 2] operación (sin recargar)");
  await ops.waitForFunction(
    (n) => Number(/Bandeja priorizada \(\d+ de (\d+)\)/i.exec(document.body.innerText)?.[1] ?? -1) > n,
    opsBefore,
    { timeout: 45_000 },
  );
  check(true, `el incidente apareció solo en /operacion, ${((Date.now() - confirmedAt) / 1000).toFixed(1)}s después de enviar`);
  check(await ops.locator("main").getByText(/Contenedor con fuego —/).first().isVisible(), "la bandeja muestra el título del incidente");
  check(await ops.locator("li.ru-fresh").count() === 1, "el incidente nuevo queda resaltado");
  await ops.screenshot({ path: `${out}/2-operacion-despues.png` });

  // --- Acto 3: cuadrilla, sin recargar ---
  console.log("\n[acto 3] cuadrilla (sin recargar)");
  const accept = unit.getByRole("button", { name: "Aceptar" });
  await accept.waitFor({ timeout: 45_000 });
  check(true, `la orden le llegó sola a la cuadrilla, ${((Date.now() - confirmedAt) / 1000).toFixed(1)}s después de enviar`);
  check(await unit.getByText("Contenedor con fuego").first().isVisible(), "la orden muestra el incidente");
  check(await unit.locator("article.ru-fresh").count() === 1, "la orden nueva queda resaltada");
  await unit.waitForFunction(() => document.title.includes("Nueva orden"), null, { timeout: 5000 });
  check(true, "la pestaña avisa «Nueva orden»");
  await unit.screenshot({ path: `${out}/3-unidad-orden.png`, fullPage: true });

  await accept.click();
  await unit.getByRole("button", { name: "Iniciar trabajo" }).click();
  await unit.getByRole("button", { name: "Completar" }).click();
  await unit.getByRole("button", { name: "Sí, completar" }).click();
  await unit.getByText("No tenés órdenes activas").waitFor({ timeout: 20_000 });
  check(true, "Aceptar → Iniciar trabajo → Completar desde la bandeja");
  await unit.screenshot({ path: `${out}/3-unidad-completada.png`, fullPage: true });
  await citizen.waitForTimeout(5000);
  await citizen.screenshot({ path: `${out}/4-ciudadano-final.png`, fullPage: true });
  await ops.locator("li", { hasText: "Resuelto" }).first().waitFor({ timeout: 15_000 });
  check(true, "/operacion muestra el incidente resuelto, sin recargar");
  await ops.screenshot({ path: `${out}/4-operacion-final.png` });
} catch (e) {
  failed = true;
  console.error(`\n✗ ${e.message}`);
} finally {
  await browser.close();
}
const relevant = errors.filter((e) => !/favicon|Download the React DevTools|\[HMR\]|\[Fast Refresh\]/.test(e));
if (relevant.length) console.log(`\nerrores en consola:\n  ${relevant.slice(0, 20).join("\n  ")}`);
// Un error de la página o de la consola también hace fallar el recorrido, aunque los actos hayan pasado.
if (relevant.length) failed = true;
console.log(failed ? "\n✗ demo en navegador falló" : `\n✓ demo en navegador completa en ${elapsed()}; capturas en ${out}/`);
process.exit(failed ? 1 : 0);
