# Núcleo B — Registro de `plan` y `dispatch` en el worker y replanificación periódica — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los jobs `plan` y `dispatch` que el pipeline ya encola tengan handler (hoy fallan tras sus intentos sin efecto) y que el worker dispare la replanificación periódica (`enqueuePeriodicPlans` existe y nadie la llama).

**Architecture:** `handlers.ts` suma dos entradas: `plan: planHandler(buildPlan)` con el `buildPlan` puro de Operación (`src/server/planning/build-plan.ts`) y `dispatch`, que llama a `applyPlan(pool, planRunId)` de Operación (`src/server/dispatch/apply-plan.ts`, contrato `ApplyPlan` en `src/server/contracts.ts`). `runWorker` gana una opción `periodic` que ejecuta una función cada N ms entre jobs; `src/worker/index.ts` la usa para `enqueuePeriodicPlans`. Sin `onFailed` para `plan` ni `dispatch`: un plan fallido lo cubre el periódico siguiente y un despacho pendiente lo reemplaza el plan siguiente (`superseded_by`).

**Tech Stack:** TypeScript, pg, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-radar-urbano-design.md` §5.3 etapas 6 y 7, §6.5, §6.7 (un incidente tiene a lo sumo una orden activa; capacidad bajo lock). Plan madre: Tareas 11 y 12 de `docs/superpowers/plans/2026-10-17-radar-urbano-mvp.md`.

**Rama y PR:** rama `nucleo/handlers-atencion` desde `epic/nucleo`, PR contra `epic/nucleo`. Antes de empezar: `/usr/bin/git fetch origin && /usr/bin/git merge origin/main` (el #15 ya está en `main`, `18e645a`) y `pnpm cli seed`. Mismo flujo de `AGENTS.md`: tests, typecheck, lint, loop de `code-review`, push, esperar el **check "Tenki Code Review"** (no los reviews), corregir o justificar en el hilo, merge. Base de test aparte: `createdb radar_urbano_test_atencion && psql -d radar_urbano_test_atencion -c "create extension postgis"` y `DATABASE_URL_TEST=postgres://localhost/radar_urbano_test_atencion pnpm vitest run …`.

## Dependencias externas (gating)

| Task | Necesita en `main` — vía el PR `epic/operacion → main` de Operación — y traído a `epic/nucleo` con `/usr/bin/git merge origin/main` (traer `main` solo no alcanza mientras ese PR no exista) |
| --- | --- |
| 1 (periódico) | nada: en ejecución en `nucleo/worker-periodico` |
| 2 (`plan`) | `src/server/planning/build-plan.ts` exportando `buildPlan: BuildPlan` — PR #11 **mergeado en `epic/operacion`** (17 oct 23:04), falta el PR `epic/operacion → main` |
| 3 (`dispatch`) | `src/server/dispatch/apply-plan.ts` exportando `applyPlan: ApplyPlan` — PR #17 (`operacion/t12 → epic/operacion`), abierto. Ya exporta `applyPlan` con la firma del contrato y devuelve `skipped: obsolete_plan` cuando el plan fue reemplazado. No toca `handlers.ts` |

Hasta que entren, los jobs `plan` siguen fallando sin efecto (comportamiento conocido, documentado en el cuerpo del #15).

**Atajo si `epic/operacion` tarda en llegar a `main`:** Tasks 2 y 3 se pueden preparar sobre `nucleo/handlers-atencion` con `/usr/bin/git merge origin/epic/operacion` para correr los tests, pero el PR a `epic/nucleo` **solo se abre cuando esos archivos estén en `main`** (si no, el PR arrastra código de Operación sin revisar por su dueño). La contingencia de implementar `applyPlan` en Núcleo queda descartada: existe el #17.

**Despliegue continuo:** desde el 17 oct cada merge a `main` despliega en Railway. Registrar `plan`/`dispatch` en `main` hace que producción empiece a crear órdenes reales en la base de Supabase: antes del PR `epic/nucleo → main`, avisar al equipo y correr `pnpm cli refresh-demo-positions` contra Supabase solo cuando se quiera ver órdenes.

## Global Constraints

- `src/server/jobs/handlers.ts` solo admite **agregar** entradas.
- Etapas 3–7 serializadas por territorio con `pg_advisory_xact_lock(hashtext(territory_id))`: `planInTx` ya lo toma; `applyPlan` lo toma por transacción de propuesta (Operación).
- Ningún dato operativo hardcodeado: el intervalo de replanificación sale de `planning.replan_interval_min` (ya lo lee `enqueuePeriodicPlans`); el tick del worker es solo la frecuencia con que se mira el reloj.
- Hooks del repo: `/usr/bin/git` dentro del worktree; Read/Edit para editar.

## Review Focus

1. Worker que arranca con un job `plan` ya pendiente de antes del despliegue (hoy `failed`): `enqueue` revive un `failed` solo si alguien reencola; el periódico encola uno nuevo (otra `dedupe_key`) ⇒ el territorio se replanifica igual. Test en Task 1 (el tick corre al arrancar, no recién a los N ms).
2. Unidades de demo con posición vencida (`position_max_age_min = 30`): el plan deja todo `stale_position` y no hay órdenes. No es bug; `refresh-demo-positions` antes de la demo. Test en Task 2 verifica el camino con posiciones frescas y el plan C lo deja en el guion.
3. Dos workers (Railway puede solapar el viejo y el nuevo en un redeploy) tomando `plan` del mismo territorio: `planHandler` ya difiere con `pg_try_advisory_xact_lock`. Sin test nuevo; cubierto en `plan-job.test.ts`.
4. `dispatch` sobre un `plan_run` que ya no es el último (job tomado justo antes de que un plan nuevo lo marque `superseded_by`): el `applyPlan` del #17 devuelve `skipped: obsolete_plan` sin crear órdenes. Test en Task 3: un plan nuevo entre el `plan` y el `dispatch` ⇒ el dispatch viejo no crea órdenes.
5. Incidente sin `problem_type_id` (Jev `unknown`): `buildSnapshot` lo marca `dispatchBlocked` ⇒ nunca recibe propuesta aunque haya unidades. Ya testeado en `plan-job.test.ts`.

---

### Task 1: Tick periódico del worker y `enqueuePeriodicPlans` en marcha

**Files:**
- Modify: `src/server/jobs/worker-loop.ts:10,47-58` (`WorkerOptions`, `runWorker`)
- Modify: `src/worker/index.ts:14-18`
- Test: `tests/db/jobs.test.ts`

**Interfaces:**
- Produces: `WorkerOptions.periodic?: { everyMs: number; run: () => Promise<void> }`. `runWorker` llama a `periodic.run()` al entrar al loop y después cada vez que pasaron ≥ `everyMs` desde la última llamada, antes de `runOnce`; un error de `run` se loguea (`opts.log`) y no corta el loop.
- Consumes: `enqueuePeriodicPlans(pool, now?)` de `src/server/pipeline/plan.ts`.

- [ ] **Step 1: Test que falla** en `tests/db/jobs.test.ts`:

```ts
it("runWorker ejecuta la tarea periódica al arrancar y luego cada everyMs, y sigue si falla", async () => {
  const pool = await testDb();
  const calls: number[] = [];
  const controller = new AbortController();
  const run = async () => { calls.push(Date.now()); if (calls.length === 2) throw new Error("tick roto"); };
  const logs: string[] = [];
  const done = runWorker(testDeps(pool), {}, { workerId: "w", idleMs: 5, signal: controller.signal, periodic: { everyMs: 40, run }, log: (m) => logs.push(m) });
  await new Promise((r) => setTimeout(r, 150));
  controller.abort();
  await done;
  expect(calls.length).toBeGreaterThanOrEqual(3);
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(35);
  expect(logs.some((m) => m.includes("tick roto"))).toBe(true);
});
```

Imports: `runWorker` de `@/server/jobs/worker-loop`, `testDeps` de `./fakes`.

- [ ] **Step 2: Correr → falla**

Run: `pnpm vitest run tests/db/jobs.test.ts -t "periódica"`
Expected: FAIL (`calls` vacío; TypeScript rechaza `periodic`).

- [ ] **Step 3: Implementar** en `runWorker`: `let lastTick = -Infinity;` y al inicio de cada vuelta `if (opts.periodic && Date.now() - lastTick >= opts.periodic.everyMs) { lastTick = Date.now(); try { await opts.periodic.run(); } catch (err) { opts.log?.(\`tarea periódica: ${err instanceof Error ? err.message : err}\`); } }`.

En `src/worker/index.ts`, pasar a `runWorker`:

```ts
periodic: {
  everyMs: 60_000,
  run: async () => {
    const n = await enqueuePeriodicPlans(getDeps().pool);
    if (n) console.log(new Date().toISOString(), `replanificación periódica: ${n} territorio(s)`);
  },
},
```

con `enqueuePeriodicPlans` importado dinámicamente junto a los otros (`await import("../server/pipeline/plan")`).

- [ ] **Step 4: Tests → PASS**

Run: `pnpm vitest run tests/db/jobs.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/server/jobs/worker-loop.ts src/worker/index.ts tests/db/jobs.test.ts
/usr/bin/git commit -m "feat(worker): tarea periódica y replanificación por intervalo de política"
```

---

### Task 2: Registrar `plan` con el `buildPlan` de Operación

**Precondición:** `src/server/planning/build-plan.ts` en `epic/nucleo` (traer `main`). Verificar: `pnpm vitest run tests/unit` o el test de Operación que acompañe a `build-plan.ts` pasa.

**Files:**
- Modify: `src/server/jobs/handlers.ts` (agregar entrada `plan`)
- Modify: `src/server/pipeline/process-report.ts` (encolar `plan` al crear o vincular; ver Step 3b)
- Test: `tests/db/plan-job.test.ts`, `tests/db/group.test.ts`

**Hueco de hoy (hallazgo de Tenki en #16):** nada encola `plan` cuando `process_report` **crea** un incidente ni cuando lo **vincula** a uno existente y la reevaluación no cambia nada efectivo. `plan` solo se encola en `recomputeEffective` con cambios (`effective.ts:97`), al archivar (`links.ts:56`), al cerrar (`overrides.ts:190`) y por el periódico. Sin arreglarlo, un incidente nuevo espera hasta `replan_interval_min` (5 min) para recibir orden, y una fuente nueva no reordena la cola.

**Interfaces:**
- Consumes: `planHandler(buildPlan)` de `src/server/pipeline/plan.ts` (devuelve `{ run(deps: { pool }, job) }`, compatible con `Handler`); `buildPlan: BuildPlan` de `@/server/planning/build-plan`; `seedDemo`, `refreshDemoPositions` de `seeds/demo.ts`; `runOnce` de `worker-loop.ts`.
- Produces: `process_report`, cuando su resultado es `applicable` con `incident_id` (los tres caminos: `grouping` `created`, `linked` y `kept_existing_link`, este último el reproceso de un reporte con vínculo manual, `process-report.ts:88`), encola en la misma transacción `enqueue(c, { kind: "plan", entityType: "territory", entityId: territoryId, entityRevision: 0, territoryId, dedupeSuffix: \`report:${reportId}\` })`. Un pedido por reporte; el handler los junta (`coalesced`).

- [ ] **Step 1: Test que falla** en `tests/db/plan-job.test.ts`:

```ts
it("el handler registrado planifica con el buildPlan de Operación: un bache va a una cuadrilla con vialidad", async () => {
  await refreshDemoPositions(pool, "montevideo");
  const bache = await incident(pool, t, { slug: "bache" });
  await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, payload: { trigger: "test" } });
  expect(await runOnce(testDeps(pool), handlers, { workerId: "w" })).toBe(true);
  const item = await one(pool, "select status, proposed_unit_id, reasons from plan_items where incident_id = $1", [bache]);
  expect(item.status).toBe("proposed");
  const caps = await pool.query("select c.slug from unit_capabilities uc join capabilities c on c.id = uc.capability_id where uc.unit_id = $1", [item.proposed_unit_id]);
  expect(caps.rows.map((r) => r.slug)).toContain("vialidad");
  expect(item.reasons).toContain("nearest_mobile");
  expect((await one(pool, "select status from jobs where kind = 'plan'")).status).toBe("done");
  expect((await one(pool, "select count(*)::int as n from jobs where kind = 'dispatch' and status = 'pending'")).n).toBe(1);
});
```

Imports: `handlers` de `@/server/jobs/handlers`, `runOnce` de `@/server/jobs/worker-loop`, `testDeps` de `./fakes`, `refreshDemoPositions` de `../../seeds/demo`.

- [ ] **Step 2: Correr → falla**

Run: `pnpm vitest run tests/db/plan-job.test.ts -t "handler registrado"`
Expected: FAIL — `sin handler para plan` (el job queda `pending` con `last_error`).

- [ ] **Step 3: Implementar** en `handlers.ts`:

```ts
import { buildPlan } from "../planning/build-plan";
import { planHandler } from "../pipeline/plan";
// …
/** Plan del territorio con el planificador puro de Operación. Sin onFailed: el periódico siguiente lo cubre. */
plan: planHandler(buildPlan),
```

- [ ] **Step 3b: Test que falla y encolado de `plan` en `process_report`.** En `tests/db/group.test.ts`, al final de `"sin candidatos ⇒ … crea el incidente …"` y de `"dos incidentes a 10 m: el reporte se asocia al correcto …"`:

```ts
expect((await pool.query("select dedupe_key from jobs where kind = 'plan' and dedupe_key like $1", [`%:report:${reportId}`])).rows).toHaveLength(1);
```

Agregar la misma aserción al final de `"reprocesar un reporte que ya tiene vínculo conserva el vínculo y no crea otro incidente"` (camino `kept_existing_link`). Correr → falla. Implementar el `enqueue` del bloque Interfaces en los tres caminos de `processReport` que devuelven `incident_id` (`created`, `linked`, `kept_existing_link`; no en `review`, `out_of_coverage`, `unrelated` ni `insufficient`). Lo más simple es hacerlo en un solo lugar: en `finish` cuando recibe `incident_id`, si `finish` corre dentro de la transacción; si no, en cada uno de los tres `return`. Correr → pasa. Commit aparte: `fix(pipeline): un incidente nuevo o una fuente nueva piden plan del territorio`. Si el plan A ya está mergeado, `process-report.ts` tiene ahí su `enqueueTextgen`: agregar este `enqueue` al lado.

- [ ] **Step 4: Tests → PASS, incluida la suite completa**

Run: `pnpm vitest run tests/db/plan-job.test.ts && pnpm test`
Expected: PASS. Atención: hasta hoy `plan` no tenía handler y varios tests lo daban por hecho (p. ej. `drain` en `tests/db/assess.test.ts:55-62` lo saltea con `kind <> 'plan'`; otros pueden asumir que la cola queda con el `plan` pendiente). Si alguno falla porque ahora `plan` corre, mantener el salteo explícito en ese test (ver `drain` con `skip` en Task 3), no cambiar la aserción de negocio.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/server/jobs/handlers.ts tests/db/plan-job.test.ts
/usr/bin/git commit -m "feat(worker): el job plan corre con el planificador de Operación"
# (el Step 3b va en su propio commit, con process-report.ts y group.test.ts)
```

---

### Task 3: Registrar `dispatch` con `applyPlan` de Operación y recorrido completo

**Precondición:** `src/server/dispatch/apply-plan.ts` en `epic/nucleo` (PR #17 mergeado en `epic/operacion`, `epic/operacion` en `main`, traer `main`).

**Files:**
- Modify: `src/server/jobs/handlers.ts` (agregar entrada `dispatch`)
- Modify: `tests/db/fakes.ts` (extraer `confirmedReport` y `drain` desde `tests/db/assess.test.ts:45-62`, exportarlos y reimportarlos ahí)
- Test: `tests/db/attention-flow.test.ts` (nuevo)

**Interfaces:**
- Consumes: `applyPlan: ApplyPlan` de `@/server/dispatch/apply-plan` — `(pool, planRunId) => Promise<{ created: string[]; skipped: { incidentId; reason }[]; stoppedForReplan: boolean }>`.
- Produces: entrada `dispatch` en `handlers`: `run(deps, job)` toma `job.payload.plan_run_id` (string; si falta, usa `job.entity_id`), llama a `applyPlan(deps.pool, planRunId)` y no hace nada más (si `stoppedForReplan`, `applyPlan` ya encoló `plan` por contrato). Sin `onFailed`.
- Produces (tests): `confirmedReport(pool, t, text?)` y `drain(pool, jev, opts?: { skip?: JobKind[]; max?: number })` exportados desde `tests/db/fakes.ts`. `drain` procesa jobs pendientes con `runOnce` hasta que no quede ninguno elegible fuera de `skip` o hasta `max` (default 30) vueltas. Los tests de `assess.test.ts` pasan `{ skip: ["plan", "dispatch"] }` (conservan su comportamiento de hoy: no quieren órdenes creadas por debajo); `attention-flow.test.ts` llama `drain(pool, jev)` sin salteos. `P` (el punto fijo `{ lon: -56.1993, lat: -34.9068 }`) también se exporta desde `fakes.ts`.

- [ ] **Step 1: Tests que fallan** en `tests/db/attention-flow.test.ts`:

```ts
describe("recorrido de atención: reporte → incidente → plan → orden", () => {
  let pool: Pool; let t: string;
  beforeEach(async () => {
    pool = await testDb(); await resetDb(pool); await seedAll(pool); await seedDemo(pool, "montevideo");
    await refreshDemoPositions(pool, "montevideo");
    t = await territoryId(pool);
  });

  it("un reporte de bache termina en una orden 'offered' para una cuadrilla con vialidad", async () => {
    const jev = fakeJev(); // fakeAnswers() por defecto: bache aplicable
    await confirmedReport(pool, t, "Hay un pozo grande en la esquina");
    await drain(pool, jev); // process_report (encola plan y textgen; Task 2 Step 3b) → plan → dispatch → textgen
    const a = await one(pool, "select a.status, a.unit_id, i.status as incident_status from assignments a join incidents i on i.id = a.incident_id");
    expect(a.status).toBe("offered");
    expect(a.incident_status).toBe("assigned");
    expect((await one(pool, "select count(*)::int as n from plan_items where status = 'executed'")).n).toBe(1);
    expect((await one(pool, "select count(*)::int as n from jobs where status = 'failed'")).n).toBe(0);
  });

  it("un dispatch de un plan ya reemplazado no crea órdenes", async () => {
    const jev = fakeJev();
    await confirmedReport(pool, t);
    // Procesar solo hasta que exista el job dispatch, sin correrlo.
    while ((await one(pool, "select count(*)::int as n from jobs where kind = 'dispatch' and status = 'pending'")).n === 0) {
      expect(await runOnce(testDeps(pool, jev), handlers, { workerId: "w" })).toBe(true);
    }
    const old = await one(pool, "select * from jobs where kind = 'dispatch' and status = 'pending'");
    await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan }); // plan nuevo: marca al viejo superseded_by
    await handlers.dispatch!.run(testDeps(pool, jev), { ...old, payload: old.payload });
    expect((await one(pool, "select count(*)::int as n from assignments")).n).toBe(0);
  });
});
```

`fakeAnswers()` (`tests/db/fakes.ts:10`) ya devuelve `problem_type: bache`, `severity: medium`, sin fuego: banda media, requiere `vialidad`. Para el segundo test, `drain` **no** sirve (correría el dispatch): el `while` con `runOnce` procesa en orden de cola hasta que aparece el `dispatch` pendiente. Nota del segundo test: el `plan_item` del viejo queda `obsolete`; `applyPlan` debe no ejecutar ítems que no estén `proposed` (si Operación no lo verifica, el hallazgo va a su PR, no a este).

- [ ] **Step 2: Correr → falla**

Run: `pnpm vitest run tests/db/attention-flow.test.ts`
Expected: FAIL — `sin handler para dispatch` ⇒ job `failed`, sin `assignments`.

- [ ] **Step 3: Implementar** la entrada `dispatch` en `handlers.ts` con la firma del bloque Interfaces, importando `applyPlan` de `../dispatch/apply-plan`. Mover `confirmedReport`, `drain` (con `skip`/`max`) y `P` a `fakes.ts`; en `assess.test.ts` reemplazar las definiciones locales por imports y las llamadas a `drain` por `drain(pool, jev, { skip: ["plan", "dispatch"] })`.

- [ ] **Step 4: Tests → PASS**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: todo en verde, incluido `assess.test.ts` con los helpers importados.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/server/jobs/handlers.ts tests/db/fakes.ts tests/db/assess.test.ts tests/db/attention-flow.test.ts
/usr/bin/git commit -m "feat(worker): el job dispatch convierte el plan en órdenes con applyPlan de Operación"
```

---

### Task 4: Smoke local y PR

- [ ] **Step 1:** `pnpm cli reset-demo --yes && pnpm cli refresh-demo-positions`; `pnpm dev` + `pnpm worker`; `node --env-file=.env.local scripts/e2e-walkthrough.mjs`. En los logs del worker: `✓ process_report` y, después, `✓ plan`, `✓ dispatch` y `✓ textgen` (el orden entre `plan` y `textgen` depende de la cola; `assess_incident` solo aparece si el reporte se agrupó con uno existente). En base: una fila en `assignments` con `status = 'offered'`. Al minuto, una línea `replanificación periódica: 1 territorio(s)` y después un `✓ plan` cada `replan_interval_min` (5 min en el seed).
- [ ] **Step 2:** Nota `docs/superpowers/notes/atencion-smoke.md`: qué se vio, latencias de `plan` y `dispatch`, y la regla "sin `onFailed` para plan/dispatch y por qué".
- [ ] **Step 3:** Loop de `code-review` → corregir → `pnpm test && pnpm typecheck && pnpm lint` → push `nucleo/handlers-atencion` → PR contra `epic/nucleo` (`Núcleo: handlers plan y dispatch, replanificación periódica`) → check "Tenki Code Review" → merge. Después, el próximo corte `epic/nucleo → main` (no se numeran: antes de abrirlo, `gh pr list --base main --head epic/nucleo --state open`; si ya hay uno abierto, por ejemplo el del plan A, este trabajo entra en ese mismo PR en vez de abrir otro), diciendo que los jobs `plan` ya tienen handler y que hay que correr `pnpm cli seed` si cambió alguna política.

```bash
/usr/bin/git add docs/superpowers/notes/atencion-smoke.md
/usr/bin/git commit -m "docs: smoke del recorrido de atención"
```
