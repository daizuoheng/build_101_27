# Núcleo A — Encolado y lectura de textos del operador — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el job `textgen` corra de verdad (hoy el handler existe y nadie lo encola) y que los módulos de UI tengan un lector de los textos vigentes de un incidente.

**Architecture:** Regla única: **cada vez que un incidente abierto nace o queda en una revisión nueva, se encola `textgen` para esa revisión**. Tres puntos de entrada en el pipeline: creación del incidente (`process-report.ts`), `runAssessIncident` dentro de su transacción y después del insert en `incident_assessments` (`assess.ts`; cubre la revisión que subió `touchIncident` al vincular, cambie o no algo efectivo), y `recomputeEffective` cuando cambió algo efectivo (`effective.ts`; cubre `setOverride` y `removeOverride`; desde `assess` es un no-op por deduplicación). Caso aparte: la promoción de banda por antigüedad en `plan.ts` no sube la revisión; ahí se invalida solo el texto `explain_priority` de la revisión vigente y se reencola con sufijo de banda. Un lector `latestTexts` en `src/server/incidents/texts.ts` devuelve los textos de la revisión actual (o `null` por propósito, y la UI muestra plantilla).

**Tech Stack:** TypeScript, pg, vitest (tests de base en `tests/db`, base `radar_urbano_test`).

**Spec:** `docs/superpowers/specs/2026-10-17-radar-urbano-design.md` §5.3 etapa 8 (`generate_text`: cacheado por revisión, fallback a plantillas, nunca bloquea otra etapa) y §6.3. Plan madre: `docs/superpowers/plans/2026-10-17-radar-urbano-mvp.md` Tarea 15.

**Rama y PR:** rama `nucleo/textgen-encolado` desde `epic/nucleo`, PR contra `epic/nucleo`. Antes de empezar: `/usr/bin/git fetch origin && /usr/bin/git merge origin/main` (el PR #15 ya está en `main`, `18e645a`, con los commits `ae281be` y `db12634` de los hallazgos de Tenki) y `pnpm cli seed` (la política `planning` exige `busy_retry_sec`; sin republicar, `assess_incident` falla con `PolicyInvalidError`). Flujo de `AGENTS.md`: `pnpm test && pnpm typecheck && pnpm lint`, loop interno de `code-review` hasta sin hallazgos graves, push, esperar el **check "Tenki Code Review"** (no los reviews), corregir o justificar en el hilo, mergear si queda limpio.

**Hilo de Tenki a cerrar:** PR #15, hilo `4304842842` («Nadie encola el job `textgen` en producción»). Este PR lo resuelve; citarlo en el cuerpo para que Tenki lo cierre.

**Base de test aparte** (para no chocar con otra sesión): `createdb radar_urbano_test_textgen && psql -d radar_urbano_test_textgen -c "create extension postgis"` y `DATABASE_URL_TEST=postgres://localhost/radar_urbano_test_textgen pnpm vitest run …`. Hoy pasan 173 tests.

## Global Constraints

- `textgen` **nunca bloquea otra etapa**: encolarlo es un `insert` idempotente dentro de la transacción del llamador; si falla la redacción, el handler cae a plantilla (ya implementado).
- Idempotencia por `kind:entityType:entityId:entityRevision` (`enqueue` en `src/server/jobs/queue.ts`); la variante por banda usa `dedupeSuffix`.
- `src/server/jobs/handlers.ts` y `scripts/cli.ts` solo admiten agregar entradas (regla de convivencia).
- Sin migraciones nuevas. Sin cambios en `src/shared/contracts/*` ni `src/server/contracts.ts` (si hiciera falta, PR aparte a `main`).
- Textos del LLM solo si `textgen.llm_purposes` lo lista; por defecto todo es determinista (ver `docs/superpowers/notes/textgen-smoke.md`).
- Hooks del repo: dentro del worktree usar `/usr/bin/git`; no usar `cat`/`grep`/`sed` para editar (Read/Edit).

## Review Focus

1. Un incidente creado con Jev caído en `assess_incident` (job `failed`): debe tener igual sus textos de la revisión 1 (los encola la creación, no la reevaluación). Test en Task 1.
2. Vincular un reporte y que `assess_incident` no cambie nada efectivo: la revisión subió en `touchIncident` y el resumen debe reflejar el nuevo `report_count`. Por eso `assess` encola siempre, no solo cuando `recomputeEffective` cambió algo. Test en Task 1.
3. Un incidente que se archiva en `detach` sube de revisión pero **no** debe encolar textos (el handler ya descarta archivados; no gastar un job). Test en Task 1.
4. La promoción `low → medium` por antigüedad se decide en `plan`, sin revisión nueva: la explicación de prioridad cacheada diría "baja". Task 2 la invalida y reencola.
5. `latestTexts` para un incidente cuya revisión actual todavía no tiene textos (job pendiente) debe devolver `null` por propósito, nunca el texto de la revisión anterior (podría describir otra banda u otro conteo). Test en Task 3.

---

### Task 1: Encolar `textgen` donde nace o queda en revisión nueva un incidente

**Files:**
- Modify: `src/server/pipeline/process-report.ts:149-160` (tras `insertLink` del incidente nuevo)
- Modify: `src/server/pipeline/assess.ts:126-141` (en la transacción de `runAssessIncident`, después del `insert into incident_assessments`)
- Modify: `src/server/incidents/effective.ts:95-101` (bloque `if (changed)`)
- Modify: `src/server/pipeline/textgen.ts:9-12` (`enqueueTextgen` acepta `dedupeSuffix`; **corregir el comentario**, que hoy afirma que `assess_incident` y `plan` ya lo llaman)
- Test: `tests/db/textgen.test.ts`, `tests/db/assess.test.ts`, `tests/db/group.test.ts`

**Interfaces:**
- Consumes: `enqueue(db, EnqueueInput)` de `src/server/jobs/queue.ts`; `unlinkReport` de `src/server/incidents/links.ts`; `setOverride` de `src/server/incidents/overrides.ts`; helpers `incidentWithReport`, `newSession`, `territoryId` de `tests/db/textgen.test.ts` y `tests/db/fakes.ts`; `incidentWithTwoReports`, `drain`, `revisionOf` de `tests/db/assess.test.ts`.
- Produces: `enqueueTextgen(c: Db, input: { incidentId: string; revision: number; territoryId: string; dedupeSuffix?: string }): Promise<void>` (firma ampliada, compatible con la actual). Comentario nuevo: "Idempotente por revisión. Lo llaman la creación del incidente, `runAssessIncident` y `recomputeEffective`; `plan` solo renueva `explain_priority` (ver `planInTx`)".

- [ ] **Step 1: Escribir los tests que fallan.** En `tests/db/textgen.test.ts`, dentro del `describe` existente:

```ts
const textgenJobs = (pool: Pool, incidentId: string) =>
  pool.query<{ entity_revision: number; dedupe_key: string }>(
    "select entity_revision, dedupe_key from jobs where kind = 'textgen' and entity_id = $1 order by entity_revision",
    [incidentId],
  );

it("una corrección del operador encola textgen para la revisión nueva", async () => {
  const pool = await testDb();
  const { incidentId } = await incidentWithReport(pool); // revisión 1, sin jobs
  // setOverride exige un operador identificado (requireOperator): mismo id fijo que tests/db/assess.test.ts.
  const operator = { type: "operator" as const, id: "00000000-0000-4000-8000-0000000000aa" };
  await withTx((c) => setOverride(c, { incidentId, override: { field: "severity", value: "low" }, reason: "test", actor: operator, expectedRevision: 1 }), pool);
  expect((await textgenJobs(pool, incidentId)).rows.map((r) => r.entity_revision)).toEqual([2]);
});

it("archivar el incidente (último reporte desvinculado) no encola textgen", async () => {
  const pool = await testDb();
  const { incidentId, reportId } = await incidentWithReport(pool);
  await withTx((c) => unlinkReport(c, { reportId, reason: "test", actor: { type: "operator", id: null } }), pool);
  expect((await pool.query("select status from incidents where id = $1", [incidentId])).rows[0].status).toBe("archived");
  expect((await textgenJobs(pool, incidentId)).rows).toHaveLength(0);
});
```

Imports a agregar: `withTx` de `@/server/db/tx`, `unlinkReport` de `@/server/incidents/links`, `setOverride` de `@/server/incidents/overrides`. Verificar en `src/shared/contracts/incident.ts` la forma exacta de `OverrideValue` para `severity` antes de fijar el literal.

Para la reevaluación: en `tests/db/assess.test.ts`, en el primer test que usa `incidentWithTwoReports` (vincula un segundo reporte y drena `assess_incident` con Jev simulado), agregar al final:

```ts
const rev = await revisionOf(pool, incidentId);
expect((await pool.query("select entity_revision from jobs where kind = 'textgen' and entity_id = $1 order by entity_revision", [incidentId])).rows.map((r) => r.entity_revision)).toContain(rev);
```

(`toContain` y no `toEqual`: si la reevaluación cambió algo efectivo, `recomputeEffective` subió la revisión y el job es para la nueva; si no, es para la que subió `touchIncident`. En los dos casos la revisión vigente tiene su job.)

Para la creación: en `tests/db/group.test.ts`, test `"sin candidatos ⇒ no llama a la comparación, crea el incidente y guarda la decisión no_candidates"` (línea ~135), agregar al final:

```ts
const created = (await pool.query("select incident_id from report_incident_links where report_id = $1 and active", [reportId])).rows[0].incident_id;
expect((await pool.query("select entity_revision from jobs where kind = 'textgen' and entity_id = $1", [created])).rows).toEqual([{ entity_revision: 1 }]);
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `pnpm vitest run tests/db/textgen.test.ts tests/db/assess.test.ts tests/db/group.test.ts`
Expected: FAIL — los `select … from jobs where kind = 'textgen'` devuelven vacío.

- [ ] **Step 3: Implementar**

- `textgen.ts`: `enqueueTextgen` pasa `dedupeSuffix` a `enqueue` si viene; comentario corregido (bloque Interfaces).
- `process-report.ts`: después de `insertLink(...)` (línea 150), `await enqueueTextgen(c, { incidentId, revision: 1, territoryId: r.territory_id })`.
- `assess.ts`: en la transacción de `runAssessIncident`, después del `insert into incident_assessments` y antes del `appendEvent`, `await enqueueTextgen(c, { incidentId: inc.id, revision: r.revision, territoryId })` (`r` es el retorno de `recomputeEffective`: trae la revisión vigente, haya cambiado o no). **No** tocar `touchIncident` ni la rama de archivado en `links.ts`.
- `effective.ts`: dentro de `if (changed)`, tras el `enqueue` de `plan`: `await enqueueTextgen(db, { incidentId, revision: upd.rows[0].revision, territoryId: cur.territory_id })`.

Comentario de una línea en cada sitio con la regla ("textos del operador: una revisión nueva, un job"). Verificar que no haya ciclo de imports (`effective.ts → pipeline/textgen → ai/llm/generate-text → config/*, db/*`; ninguno vuelve a `incidents/`).

- [ ] **Step 4: Tests → PASS**

Run: `pnpm vitest run tests/db/textgen.test.ts tests/db/group.test.ts tests/db/assess.test.ts`
Expected: PASS. Si algún test de `assess.test.ts` cuenta jobs con `select count(*) from jobs` sin filtrar por `kind`, ajustarlo a `kind <> 'textgen'` o al kind que mide.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/server/pipeline/process-report.ts src/server/pipeline/assess.ts src/server/incidents/effective.ts src/server/pipeline/textgen.ts tests/db/textgen.test.ts tests/db/assess.test.ts tests/db/group.test.ts
/usr/bin/git commit -m "feat(textgen): el pipeline encola los textos en cada revisión nueva del incidente"
```

---

### Task 2: Promoción de banda en `plan` invalida y reencola `explain_priority`

**Files:**
- Modify: `src/server/pipeline/plan.ts:168-173` (el `update incidents set priority_band …` de `planInTx`)
- Test: `tests/db/plan-job.test.ts`

**Interfaces:**
- Consumes: `enqueueTextgen` con `dedupeSuffix` (Task 1); `computePriority` de `src/server/pipeline/priority.ts` (su `breakdown` trae `rules`, `promoted_by_age`, `age_hours`, `inputs`, `computed_at`).
- Produces: nada nuevo exportado.

- [ ] **Step 1: Test que falla** en `tests/db/plan-job.test.ts`:

```ts
it("una banda promovida por antigüedad actualiza el desglose, invalida la explicación de prioridad y reencola textgen", async () => {
  const viejo = await incident(pool, t, { slug: "bache", severity: "low", hoursAgo: 50 }); // priority_band 'low' en el insert
  await pool.query(
    `insert into generated_texts (purpose, entity_type, entity_id, entity_revision, body) values
       ('explain_priority', 'incident', $1, 1, 'Prioridad baja'), ('title', 'incident', $1, 1, 'Bache')`,
    [viejo],
  );
  await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
  const inc = await one(pool, "select priority_band, priority_breakdown from incidents where id = $1", [viejo]);
  expect(inc.priority_band).toBe("medium");
  expect(inc.priority_breakdown).toMatchObject({ promoted_by_age: true, computed_band: "medium" });
  expect((await pool.query("select purpose from generated_texts where entity_id = $1 order by purpose", [viejo])).rows).toEqual([{ purpose: "title" }]);
  const job = await one(pool, "select entity_revision, dedupe_key from jobs where kind = 'textgen' and entity_id = $1", [viejo]);
  expect(job).toMatchObject({ entity_revision: 1 });
  expect(job.dedupe_key).toMatch(/:band:medium$/);

  // Segunda corrida sin cambio de banda: no borra ni encola de nuevo.
  await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
  expect((await one(pool, "select count(*)::int as n from jobs where kind = 'textgen' and entity_id = $1", [viejo])).n).toBe(1);
});
```

- [ ] **Step 2: Correr → falla**

Run: `pnpm vitest run tests/db/plan-job.test.ts -t "promovida por antigüedad"`
Expected: FAIL (`priority_breakdown` sin `promoted_by_age`, `explain_priority` sigue, sin job).

- [ ] **Step 3: Implementar en `planInTx`**

Reemplazar el `update incidents … from unnest(...)` por una versión que devuelva los cambiados: `… where i.id = b.id and i.priority_band <> b.band returning i.id, i.revision, b.band`. Para que el desglose coincida, `buildSnapshot` debe devolver también el `breakdown` calculado por incidente (ampliar su retorno con `breakdowns: Record<string, Record<string, unknown>>`, solo para los que no tienen `band_override`), y el `update` escribe `priority_breakdown = priority_breakdown || $breakdown || jsonb_build_object('computed_band', band)` (conserva `band_override` si lo hubiera; con override la banda no cambia y la fila no entra). Por cada fila devuelta:

```ts
await c.query("delete from generated_texts where purpose = 'explain_priority' and entity_type = 'incident' and entity_id = $1 and entity_revision = $2", [row.id, row.revision]);
await enqueueTextgen(c, { incidentId: row.id, revision: row.revision, territoryId: input.territoryId, dedupeSuffix: `band:${row.band}` });
```

Comentario: la banda por antigüedad cambia sin revisión nueva; se renueva solo la explicación.

- [ ] **Step 4: Tests → PASS**

Run: `pnpm vitest run tests/db/plan-job.test.ts`
Expected: PASS, incluidos los tests existentes (el que verifica `priority_band = 'medium'` para `viejo` sigue válido).

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add src/server/pipeline/plan.ts tests/db/plan-job.test.ts
/usr/bin/git commit -m "feat(plan): la promoción por antigüedad renueva la explicación de prioridad"
```

---

### Task 3: Lector `latestTexts` para las vistas

**Files:**
- Create: `src/server/incidents/texts.ts`
- Test: `tests/db/textgen.test.ts`

**Interfaces:**
- Produces: `type IncidentTexts = { revision: number; title: string | null; summary: string | null; explain_priority: string | null }`; `latestTexts(db: Db, incidentId: string): Promise<IncidentTexts>` — lee `incidents.revision` y los `generated_texts` **de esa revisión exacta**; propósito sin fila ⇒ `null` (la UI muestra su plantilla o el `incidents.title` determinista). Una sola consulta (`left join` sobre `generated_texts` con `entity_revision = i.revision`).
- Produces: `latestTextsMany(db: Db, incidentIds: string[]): Promise<Map<string, IncidentTexts>>` para listas (una consulta con `= any($1)`).
- Consumers previstos: `src/app/operacion/*` (Operación) y `UnitAssignmentCard.incident.summary` (Recepción). Avisar en el PR; no tocar sus archivos.

- [ ] **Step 1: Test que falla** en `tests/db/textgen.test.ts`:

```ts
it("latestTexts devuelve solo los textos de la revisión vigente; sin texto, null", async () => {
  const pool = await testDb();
  const { incidentId } = await incidentWithReport(pool); // revisión 1
  await pool.query(
    `insert into generated_texts (purpose, entity_type, entity_id, entity_revision, body) values
       ('title', 'incident', $1, 1, 'Bache en Av. Italia'), ('summary', 'incident', $1, 1, 'Un pozo')`,
    [incidentId],
  );
  expect(await latestTexts(pool, incidentId)).toEqual({ revision: 1, title: "Bache en Av. Italia", summary: "Un pozo", explain_priority: null });
  await pool.query("update incidents set revision = 2 where id = $1", [incidentId]);
  expect(await latestTexts(pool, incidentId)).toEqual({ revision: 2, title: null, summary: null, explain_priority: null });
  const many = await latestTextsMany(pool, [incidentId]);
  expect(many.get(incidentId)?.revision).toBe(2);
});
```

- [ ] **Step 2: Correr → falla**

Run: `pnpm vitest run tests/db/textgen.test.ts -t "latestTexts"`
Expected: FAIL con módulo inexistente.

- [ ] **Step 3: Implementar `src/server/incidents/texts.ts`** con las dos firmas de arriba (`latestTexts` delega en `latestTextsMany`).

- [ ] **Step 4: Tests → PASS**

Run: `pnpm vitest run tests/db/textgen.test.ts`
Expected: PASS.

- [ ] **Step 5: Verificación completa y commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: todo en verde (170+ tests).

```bash
/usr/bin/git add src/server/incidents/texts.ts tests/db/textgen.test.ts
/usr/bin/git commit -m "feat(incidents): lector de los textos vigentes de un incidente para las vistas"
```

---

### Task 4: Verificación real y PR

- [ ] **Step 1: Smoke local.** Con `pnpm dev` y `pnpm worker` corriendo, `node --env-file=.env.local scripts/e2e-walkthrough.mjs`. En los logs del worker debe verse `✓ textgen <id>@1` después de `✓ process_report`. En base: `select purpose, entity_revision, llm_run_id is null as plantilla from generated_texts` ⇒ tres filas de la revisión 1 (plantilla, porque `llm_purposes` del seed está vacío).
- [ ] **Step 2: Nota.** Agregar a `docs/superpowers/notes/textgen-smoke.md` una sección "Encolado (fecha)" con la regla de los tres puntos de entrada, el caso de la banda por antigüedad y lo observado en el smoke (3 líneas).
- [ ] **Step 3: Loop de review y PR** según `AGENTS.md`: `code-review` sobre el diff → corregir → repetir hasta sin hallazgos graves; `pnpm test && pnpm typecheck && pnpm lint`; push de `nucleo/textgen-encolado`; PR contra `epic/nucleo` con título `Núcleo: encolado de textgen y lector de textos`; en el cuerpo, citar el hilo `4304842842` del PR #15 como resuelto y avisar a Operación y Recepción de `latestTexts`/`latestTextsMany`. Esperar el check "Tenki Code Review"; mergear si queda limpio.
- [ ] **Step 4: Llevarlo a `main`.** Con A mergeado en `epic/nucleo`, quien coordina Núcleo abre el corte `epic/nucleo → main` (segundo corte; el #15 fue el primero) **sin esperar al plan B**, que puede tardar por Operación. Ese merge despliega en producción. Después del merge: `pnpm cli seed` contra Supabase solo si A cambió seeds de políticas (no debería). Si B Task 1 (`nucleo/worker-periodico`) ya está en `epic/nucleo`, entra en el mismo corte.

```bash
/usr/bin/git commit -am "docs(textgen): nota del encolado y del smoke"
```
