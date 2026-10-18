# Núcleo D — Cierre del pipeline: plan inmediato y textos visibles — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Las Tasks 1, 2 y 3 son independientes** (no comparten archivos de código) y se ejecutan en paralelo, cada una en su rama y su PR. La Task 4 la hace quien coordina.

**Goal:** Que un reporte nuevo reciba orden enseguida (hoy espera hasta 5 min al periódico) y que los textos que textgen ya genera en producción aparezcan en la consola del operador y en la bandeja `/unidad` (hoy nadie los muestra).

**Contexto (17 oct, noche, `main` = `60de192`):** con #22 (Operación) y #23 (Recepción) en `main`, `handlers.ts` ya registra `plan: planHandler(buildPlan)` y `dispatch → applyPlan`, y la replanificación periódica se activó sola. `tests/db/dispatch.test.ts` (Operación) cubre concurrencia, capacidad, revalidación y obsolescencia. Suite: 285 tests. Este plan reemplaza lo que quedaba de las Tasks 2 y 3 del plan B.

**Architecture:**
- **Task 1:** `process_report` encola `plan` del territorio en los tres caminos que devuelven `incident_id`. Test de recorrido completo reporte → orden `offered`.
- **Task 2:** `runTextgen`, al persistir la revisión vigente, copia `title` y `summary` a las columnas `incidents.title` e `incidents.summary`. Esas columnas ya existen y las leen la lista del operador (`src/server/planning/queries.ts:29`, `coalesce(i.title, …)`) y la bandeja (`src/server/unit/inbox.ts:37`, `i.summary`). Así no se tocan archivos de Operación ni de Recepción. `recomputeEffective` deja de pisar `title` cuando no hay revisión nueva.

**Tech Stack:** TypeScript, pg, vitest.

**Spec:** diseño §5.3 etapas 6–8 (`docs/superpowers/specs/2026-10-17-radar-urbano-design.md`); plan B (`2026-10-17-nucleo-b-handlers-plan-dispatch.md`, Task 2 Step 3b y Task 3) y plan A (`2026-10-17-nucleo-a-textgen-encolado.md`).

## Global Constraints

- Ramas desde `origin/epic/nucleo` (= `main` = `60de192`): Task 1 en `nucleo/plan-inmediato`, Task 2 en `nucleo/textos-visibles`. PR de cada una contra `epic/nucleo`.
- Sin migraciones ni cambios en `src/shared/contracts/*`, `src/server/contracts.ts`, `seeds/`. `handlers.ts` no se toca: ya está completo.
- **No tocar archivos de Operación** (`src/server/{planning,dispatch,review}`, `src/app/operacion`, `src/app/api/operacion`) **ni de Recepción** (`src/app/{reportar,unidad}`, `src/app/api/{reportar,unidad}`, `src/server/unit`, `src/server/intake/branches.ts`).
- Base de test propia por agente: `createdb radar_urbano_test_<rama> && psql -d radar_urbano_test_<rama> -c "create extension postgis"`, `DATABASE_URL_TEST=postgres://localhost/radar_urbano_test_<rama>`. Variables locales de test: `DEMO_OPERATOR_PASSWORD`, `DEMO_UNIT_PASSWORD` (cualquier valor local; sin ellas fallan 25 tests de seeds de demo) y `SESSION_SECRET`.
- `git` dentro del worktree: `/usr/bin/git`. Editar con Read/Edit, no `sed`.
- **Cada merge a `main` despliega a producción.** Los PRs de este plan van a `epic/nucleo`; el corte a `main` lo abre quien coordina, cuando las dos tareas estén mergeadas.
- Flujo de `AGENTS.md`: tests + typecheck + lint, loop de revisión interna hasta sin hallazgos graves, push, check "Tenki Code Review", corregir o justificar en el hilo, mergear si queda limpio.

## Review Focus

1. **Doble `plan` por reporte:** `process_report` encola `plan` y, si se vinculó, `assess_incident` puede encolar otro por `recomputeEffective` con cambios. El handler los junta (`coalesced`) y no hace dos corridas en paralelo. Test en Task 1: un reporte vinculado deja como máximo una corrida de `plan` con propuestas por cada drenaje.
2. **Reproceso `kept_existing_link`:** un `process_report` reintentado después de fallar a mitad debe pedir `plan` igual. Test en Task 1.
3. **Título del LLM pisado:** `recomputeEffective` hoy escribe `title` determinista en cada llamada, aunque no cambie nada (`effective.ts:82-88`). Si textgen ya copió su título a esa revisión, una reevaluación sin cambios lo reemplazaría por el determinista. Test en Task 2.
4. **Texto de una revisión vieja en la columna:** si la revisión subió mientras textgen redactaba, la copia a `incidents.title/summary` no debe ocurrir. Se resuelve en la misma transacción que el `isCurrent`. Test en Task 2.
5. **Incidente archivado:** ni Task 1 ni Task 2 escriben sobre un incidente `archived`. Ya está cubierto por los descartes existentes; verificar que ningún camino nuevo los saltee.

---

### Task 1: `plan` inmediato desde `process_report` y recorrido completo

**Files:**
- Modify: `src/server/pipeline/process-report.ts` (los tres `return finish("applicable", { incident_id, … })`: líneas ~88, ~123 y ~162)
- Modify: `tests/db/fakes.ts` (exportar `P`, `confirmedReport`, `drain` con `skip`/`max`, movidos desde `tests/db/assess.test.ts`)
- Modify: `tests/db/assess.test.ts` (importar esos helpers; sus `drain` pasan `{ skip: ["plan", "dispatch"] }` para conservar el comportamiento actual)
- Modify: `tests/db/group.test.ts`
- Create: `tests/db/attention-flow.test.ts`

**Interfaces:**
- Produces: en `processReport`, cuando el resultado es `applicable` con `incident_id` (`grouping` `created`, `linked` o `kept_existing_link`), dentro de la misma transacción: `enqueue(c, { kind: "plan", entityType: "territory", entityId: territoryId, entityRevision: 0, territoryId, payload: { trigger: "report" }, dedupeSuffix: \`report:${reportId}\` })`. Un pedido por reporte; `planHandler` junta los pendientes. Si `finish` corre dentro de la transacción y recibe `incident_id`, encolar ahí una sola vez; si no, en cada uno de los tres `return`.
- Produces (tests): `P = { lon: -56.1993, lat: -34.9068 }`, `confirmedReport(pool, t, text?)` y `drain(pool, jev, opts?: { skip?: JobKind[]; max?: number })` exportados desde `tests/db/fakes.ts`. `drain` corre `runOnce` mientras haya un job `pending`, elegible (`run_after <= now()`) y fuera de `skip`, hasta `max` vueltas (30 por defecto).
- Consumes: `refreshDemoPositions(pool, "montevideo")` y `seedDemo` de `seeds/demo.ts`; `handlers` de `src/server/jobs/handlers.ts` (ya con `plan` y `dispatch`).

- [ ] **Step 1: Tests que fallan.** En `tests/db/group.test.ts`, al final de `"sin candidatos ⇒ … crea el incidente …"`, `"dos incidentes a 10 m: el reporte se asocia al correcto …"` y `"reprocesar un reporte que ya tiene vínculo conserva el vínculo …"`:

```ts
expect((await pool.query("select 1 from jobs where kind = 'plan' and dedupe_key like $1", [`%:report:${reportId}`])).rows).toHaveLength(1);
```

Crear `tests/db/attention-flow.test.ts`:

```ts
describe("recorrido de atención: reporte → incidente → plan → orden", () => {
  let pool: Pool; let t: string;
  beforeEach(async () => {
    pool = await testDb(); await resetDb(pool); await seedAll(pool); await seedDemo(pool, "montevideo");
    await refreshDemoPositions(pool, "montevideo");
    t = await territoryId(pool);
  });

  it("un reporte de bache termina en una orden 'offered' para una cuadrilla con vialidad, sin esperar al periódico", async () => {
    const jev = fakeJev(); // fakeAnswers(): bache, severidad media, sin fuego ⇒ requiere vialidad
    await confirmedReport(pool, t, "Hay un pozo grande en la esquina");
    await drain(pool, jev);
    const a = await one(pool, `select a.status, i.status as incident_status, array(select c.slug from unit_capabilities uc join capabilities c on c.id = uc.capability_id where uc.unit_id = a.unit_id) as caps
                               from assignments a join incidents i on i.id = a.incident_id`);
    expect(a.status).toBe("offered");
    expect(a.incident_status).toBe("assigned");
    expect(a.caps).toContain("vialidad");
    expect((await one(pool, "select count(*)::int as n from jobs where status = 'failed'")).n).toBe(0);
    expect((await one(pool, "select trigger from plan_runs order by computed_at limit 1")).trigger).toMatch(/^report/);
  });

  it("un segundo reporte vinculado al mismo incidente no crea otra orden", async () => {
    const jev = fakeJev((call) => ("evolution" in call.questions ? { ...fakeAnswers(), evolution: { type: "choice", choice: "same", confidence: 0.9, probabilities: { same: 0.95 } } } : fakeAnswers()));
    await confirmedReport(pool, t);
    await drain(pool, jev);
    await confirmedReport(pool, t, "Sigue el pozo");
    await drain(pool, jev);
    expect((await one(pool, "select count(*)::int as n from assignments")).n).toBe(1);
  });
});
```

Verificar en `tests/db/group.test.ts` cómo se arma la respuesta de comparación de Jev para que el segundo reporte se **vincule** (`fakeComparison` con `match: "same"`). Si `fakeJev` por defecto no compara candidatos, usar ese patrón en el segundo test. `ch` y `one` locales como en `assess.test.ts`.

- [ ] **Step 2: Correr → falla.**
Run: `DATABASE_URL_TEST=… pnpm vitest run tests/db/group.test.ts tests/db/attention-flow.test.ts`
Expected: FAIL. Las aserciones de `report:<id>` dan vacío, y el recorrido no crea la orden: el único `plan` sería el periódico, que en el test no corre.

- [ ] **Step 3: Implementar** el `enqueue` del bloque Interfaces y mover los helpers a `fakes.ts`.

- [ ] **Step 4: Suite completa → PASS.**
Run: `DATABASE_URL_TEST=… pnpm test && pnpm typecheck && pnpm lint`
Expected: todo verde (285 + los nuevos). Si un test existente de Operación o Núcleo cuenta jobs `plan` sin filtrar y ahora ve uno de más, ajustar **solo si es de Núcleo**. Si es de Operación, no tocarlo: anotarlo en el PR y avisar.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/server/pipeline/process-report.ts tests/db/fakes.ts tests/db/assess.test.ts tests/db/group.test.ts tests/db/attention-flow.test.ts
/usr/bin/git commit -m "feat(pipeline): un incidente nuevo o una fuente nueva piden plan del territorio en el acto"
```

- [ ] **Step 6: PR** `Núcleo: plan inmediato al procesar un reporte y recorrido de atención` contra `epic/nucleo`, citando los hilos 4304914180 y 4304942939 del #16 (donde Tenki marcó el hueco).

---

### Task 2: Textos generados visibles en la consola y la bandeja

**Files:**
- Modify: `src/server/pipeline/textgen.ts` (`runTextgen`, después de que los tres propósitos se resolvieron)
- Modify: `src/server/incidents/effective.ts:78-88` (`recomputeEffective`: `title` solo cuando `changed`)
- Test: `tests/db/textgen.test.ts`, `tests/db/assess.test.ts`

**Interfaces:**
- Produces: al final de `runTextgen`, si no hubo descarte (`discarded === false`), una transacción que hace `select revision, status from incidents where id = $1 for update`. Si la revisión sigue siendo `job.entity_revision` y el incidente no está `archived`, ejecuta `update incidents set title = $2, summary = $3, updated_at = now() where id = $1`, con los `body` de `title` y `summary` de esa revisión (los que devolvió `generateText`, sea LLM, plantilla o caché). Si cambió la revisión, no escribe nada: el job de la revisión nueva lo hará.
- `runTextgen` devuelve además `applied: boolean` (si escribió las columnas), para el log y los tests.
- Produces: `recomputeEffective` incluye `title` en el `update` **solo si `changed`**. Si no hubo cambio efectivo, la revisión no sube y el título que copió textgen se conserva. Con revisión nueva, el título determinista queda hasta que corra el textgen de esa revisión, que lo reemplaza.
- `explain_priority` no tiene columna. Queda accesible por `latestTexts` (`src/server/incidents/texts.ts`) para cuando Operación lo muestre en el detalle; anotarlo en el PR como propuesta a Operación. No tocar sus archivos.

- [ ] **Step 1: Tests que fallan** en `tests/db/textgen.test.ts`:

```ts
it("el handler copia título y resumen de la revisión vigente a las columnas del incidente", async () => {
  const pool = await testDb();
  const { incidentId, territory } = await incidentWithReport(pool);
  await enqueueTextgen(pool, { incidentId, revision: 1, territoryId: territory });
  const job = (await claimNext(pool, "w", 60))!;
  const res = await runTextgen({ pool, llm: null }, job);
  expect(res.applied).toBe(true);
  const inc = (await pool.query("select title, summary from incidents where id = $1", [incidentId])).rows[0];
  const texts = await latestTexts(pool, incidentId);
  expect(inc).toEqual({ title: texts.title, summary: texts.summary });
  expect(inc.summary).not.toBeNull();
});

it("si la revisión cambió antes de copiar, no escribe las columnas", async () => {
  const pool = await testDb();
  const { incidentId, territory } = await incidentWithReport(pool);
  const before = (await pool.query("select title, summary from incidents where id = $1", [incidentId])).rows[0];
  await enqueueTextgen(pool, { incidentId, revision: 1, territoryId: territory });
  const job = (await claimNext(pool, "w", 60))!;
  const llm = fakeLlm(async (call) => { await pool.query("update incidents set revision = 2 where id = $1", [incidentId]); return citeFirst(call); });
  const res = await runTextgen({ pool, llm }, job);
  expect(res.applied).toBe(false);
  expect((await pool.query("select title, summary from incidents where id = $1", [incidentId])).rows[0]).toEqual(before);
});
```

El segundo test necesita que algún propósito pase por el LLM. Usar el `beforeEach` del archivo, que ya activa los tres en `llm_purposes`.

En `tests/db/assess.test.ts`, con un incidente cuya reevaluación **no cambia nada efectivo** (el patrón de `jevAssess()` con las mismas respuestas que la evaluación inicial):

```ts
await pool.query("update incidents set title = 'Título de textgen' where id = $1", [incidentId]);
// … drenar assess_incident sin cambios efectivos …
expect((await one(pool, "select title from incidents where id = $1", [incidentId])).title).toBe("Título de textgen");
```

- [ ] **Step 2: Correr → falla.**
Run: `DATABASE_URL_TEST=… pnpm vitest run tests/db/textgen.test.ts tests/db/assess.test.ts`
Expected: FAIL (`applied` undefined, columnas sin copiar, título pisado por `recomputeEffective`).

- [ ] **Step 3: Implementar** según el bloque Interfaces. En `effective.ts`, el `update` pasa a `title = case when $10 = 1 then $9 else title end`, o se arma en dos ramas; elegir la que deje el SQL más legible. En el comentario, una línea: "el título determinista es el respaldo; textgen lo reemplaza por revisión".

- [ ] **Step 4: Suite completa → PASS.**
Run: `DATABASE_URL_TEST=… pnpm test && pnpm typecheck && pnpm lint`
Expected: verde. Si un test de Operación o Recepción esperaba el título determinista exacto después de un textgen, no tocarlo: anotarlo en el PR.

- [ ] **Step 5: Smoke local.** Con la base de desarrollo propia (`migrate`, `seed`, `seed-demo`), `pnpm dev` + `pnpm worker` y `scripts/e2e-walkthrough.mjs`: después de `✓ textgen …@1`, `GET /api/operacion/incidents` (sesión de operador) devuelve el título de textgen y `select summary from incidents` no está vacío. Si el smoke no es viable, decirlo en el PR.

- [ ] **Step 6: Commit y PR**

```bash
/usr/bin/git add src/server/pipeline/textgen.ts src/server/incidents/effective.ts tests/db/textgen.test.ts tests/db/assess.test.ts
/usr/bin/git commit -m "feat(textgen): título y resumen vigentes visibles en la consola y la bandeja de la unidad"
```

PR `Núcleo: textos generados visibles (título y resumen en las columnas del incidente)` contra `epic/nucleo`. En el cuerpo, la propuesta a Operación de mostrar `explain_priority` con `latestTexts`.

---

### Task 3: Plantillas del seed que cambiaron en una base ya sembrada (`template-upgrade`)

**Por qué (hallazgo del 17 oct, noche):** #23 (Recepción) agregó a `seeds/templates.ts` tres claves nuevas (`ask_location_retry`, `status_not_found`, `status_rate_limited`) y cambió el texto de cuatro existentes (`ask_location`, `location_proposed`, `location_not_found`, `draft_ready`) para el flujo de respuestas por texto. En `seedAll` (`seeds/index.ts:98-104`) las plantillas se insertan con `on conflict do nothing`. Por eso, en una base ya sembrada como producción:
- `pnpm cli seed` agrega las claves nuevas. Sin eso, `renderTemplate` lanza `TemplateMissingError`.
- `pnpm cli seed` **no actualiza** los textos cambiados. Producción sigue pidiendo «tocá Enviar» mientras el flujo espera «respondé "enviar"».

Lo mismo le va a pasar a cualquier cambio futuro de texto. Las plantillas son configuración editable por operación (diseño §6.7: "los seeds no actualizan filas que operación haya tocado"), así que no se pisan solas: hace falta un comando explícito, como `policy-upgrade` para las políticas.

**Files:**
- Create: `seeds/template-upgrade.ts`
- Modify: `scripts/cli.ts` (agregar la entrada `template-upgrade`; el archivo solo admite agregar entradas)
- Create test: `tests/db/template-upgrade.test.ts` (archivo propio: `seeds.test.ts` siembra una vez en `beforeAll` y sus tests dependen de ese estado; este test resetea la base)

**Interfaces:**
- Produces: `upgradeTemplates(pool: Pool, opts: { keys: string[] | "all"; dryRun?: boolean }): Promise<{ updated: string[]; inserted: string[]; unchanged: string[]; unknown: string[] }>`. Solo sobre filas **globales** (`territory_id is null`) del locale de cada plantilla del seed. Para cada clave pedida que esté en `seeds/templates.ts`: si no existe, la inserta; si existe con otro `body` o `variables`, la actualiza; si es igual, la deja. Una clave pedida que no está en el seed va a `unknown` y no hace nada. Nunca toca filas con `territory_id` (personalizaciones por territorio). Todo en una transacción. Con `dryRun`, devuelve lo mismo sin escribir.
- CLI: `pnpm cli template-upgrade --keys ask_location,draft_ready [--dry-run]` o `--all`. Imprime las cuatro listas y sale con código 2 si `unknown` no está vacía. Registra un `events` por clave actualizada (`entity_type: "message_template"`, `kind: "template_upgraded"`, `actor_type: "system"`, `data: { key, locale, previous_body }`), para poder volver atrás a mano.

- [ ] **Step 1: Tests que fallan** en `tests/db/template-upgrade.test.ts` (dentro de un `describe("template-upgrade", …)`, con imports de `vitest`, `seedAll` de `../../seeds`, `resetDb`/`testDb` de `./setup`):

```ts
it("template-upgrade actualiza el texto global cambiado en el seed, inserta las claves nuevas y no toca las de territorio", async () => {
  const pool = await testDb(); await resetDb(pool); await seedAll(pool, { importAreas: false });
  const t = await territoryId(pool);
  const draft = templates.find((x) => x.key === "draft_ready")!;
  await pool.query("update message_templates set body = 'texto viejo' where key = 'draft_ready' and territory_id is null");
  await pool.query("delete from message_templates where key = 'status_not_found'");
  await pool.query("insert into message_templates (territory_id, key, locale, body, variables) values ($1, 'draft_ready', 'es', 'personalizado', '[]')", [t]);

  const dry = await upgradeTemplates(pool, { keys: ["draft_ready", "status_not_found", "no_existe"], dryRun: true });
  expect(dry).toEqual({ updated: ["draft_ready"], inserted: ["status_not_found"], unchanged: [], unknown: ["no_existe"] });
  expect((await pool.query("select body from message_templates where key = 'draft_ready' and territory_id is null")).rows[0].body).toBe("texto viejo");

  await upgradeTemplates(pool, { keys: ["draft_ready", "status_not_found"] });
  expect((await pool.query("select body from message_templates where key = 'draft_ready' and territory_id is null")).rows[0].body).toBe(draft.body);
  expect((await pool.query("select body from message_templates where key = 'draft_ready' and territory_id = $1", [t])).rows[0].body).toBe("personalizado");
  expect((await pool.query("select count(*)::int as n from message_templates where key = 'status_not_found'")).rows[0].n).toBe(1);
  expect((await pool.query("select data->>'previous_body' as prev from events where kind = 'template_upgraded'")).rows).toEqual([{ prev: "texto viejo" }]);

  expect(await upgradeTemplates(pool, { keys: "all" })).toMatchObject({ updated: [], inserted: [], unknown: [] });
});
```

Imports: `templates` de `../../seeds/templates`, `upgradeTemplates` de `../../seeds/template-upgrade`, `territoryId` de `./fakes`.

- [ ] **Step 2: Correr → falla** (módulo inexistente).
- [ ] **Step 3: Implementar** `seeds/template-upgrade.ts` y la entrada del CLI (`--keys`, `--all`, `--dry-run`, como `policy-upgrade`).
- [ ] **Step 4: Suite completa → PASS** (`DATABASE_URL_TEST=… pnpm test && pnpm typecheck && pnpm lint`).
- [ ] **Step 5: Documentar** en `docs/superpowers/notes/despliegue.md`, sección "Seeds después de un merge": `pnpm cli seed` agrega lo que falta; `pnpm cli template-upgrade --dry-run --all` muestra los textos del seed que difieren de la base y `--keys …` los aplica. Agregar la misma regla, en una línea, a `AGENTS.md` en el flujo de integración: "si el merge cambia `seeds/templates.ts`, después del deploy: `pnpm cli seed && pnpm cli template-upgrade --keys <las cambiadas>` contra Supabase".
- [ ] **Step 6: Commit y PR** `Núcleo: template-upgrade para textos del seed en bases ya sembradas` contra `epic/nucleo`, en la rama `nucleo/template-upgrade`. En el cuerpo: la lista exacta de claves que #23 cambió o agregó y el comando a correr en producción.

```bash
/usr/bin/git add seeds/template-upgrade.ts scripts/cli.ts tests/db/template-upgrade.test.ts docs/superpowers/notes/despliegue.md AGENTS.md
/usr/bin/git commit -m "feat(seeds): template-upgrade aplica a una base sembrada los textos del seed que cambiaron"
```

---

### Task 4: Corte a `main` (quien coordina)

- [ ] Con las Tasks 1, 2 y 3 mergeadas en `epic/nucleo`: `gh pr list --base main --head epic/nucleo --state open`. Si no hay ninguno abierto, abrir el PR `epic/nucleo → main`, correr la suite completa sobre la cabeza y esperar a Tenki. **Mergear despliega.** Después del deploy, contra Supabase: `pnpm cli seed && pnpm cli template-upgrade --keys ask_location,location_proposed,location_not_found,draft_ready,ask_location_retry,status_not_found,status_rate_limited` (son los cambios de #23; Task 3), y `pnpm cli policy-upgrade --kind intake` si se quieren activar `replies` y `status_lookup` de #23 (el esquema los acepta ausentes, así que sin eso no se rompe nada: solo quedan apagados).
