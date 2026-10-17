# Radar Urbano MVP — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un reporte ciudadano por chat se evalúa con Jev, se agrupa, se prioriza, se planifica y se asigna a una unidad que lo acepta desde su bandeja, con el operador trabajando una cola de revisión; todo desplegado y usable desde celulares reales.

**Architecture:** Monolito modular Next.js 16 con un worker Node del mismo repo; PostgreSQL + PostGIS como fuente de verdad; jobs persistidos con lease; Jev decide, LLM redacta bajo demanda, el backend aplica políticas versionadas desde base. Pipeline autónomo; el humano entra por `review_items` y overrides.

**Tech Stack:** TypeScript, Node ≥ 22, Next.js 16.4, React 19, Zod 4, `pg` 8, PostGIS, `@typesafe-ai/sdk` 0.7, `openai` 7 (como cliente de un endpoint compatible: modelo open source en Tenki), `sharp`, `iron-session`, Leaflet, Vitest, `tsx`. Railway + Supabase.

**Spec:** `docs/superpowers/specs/2026-10-17-radar-urbano-design.md` (prevalece) y `ALCANCE-RADAR-URBANO.md`, `ARQUITECTURA-RADAR-URBANO.md`, `INTEGRACION-JEV.md`.

## Global Constraints

- Ningún dato operativo en código ni prompts: territorios, áreas, catálogo, capacidades, unidades, umbrales, radios, ventanas, plantillas y contactos vienen de base. Base vacía ⇒ estado vacío real.
- Seeds idempotentes por clave natural (`slug`, `external_id`, `key`); no actualizan filas tocadas por operación. `reset-demo` y `refresh-demo-positions` son comandos aparte.
- Jev no produce texto; el LLM no decide tipo ni severidad ni confirma nada; permisos e identidad nunca vienen de un modelo; el texto ciudadano es evidencia, no instrucción.
- Umbrales se comparan contra `probabilities[choice]`; Noul contra `noul`. Respuesta favorable **y** umbral.
- Una orden activa por incidente (índice único parcial); capacidad de unidad verificada bajo `FOR UPDATE`; un vínculo activo por reporte.
- Cada resultado de IA guarda la revisión que evaluó; si cambió, se descarta y reencola.
- Integraciones reales siempre; nada simulado salvo tests unitarios marcados. Sin credenciales, el paso queda documentado como bloqueado, no fingido.
- Credenciales solo por entorno. `.env` gitignoreado.
- Espacial: `geography(Point,4326)` para puntos, `geometry(MultiPolygon,4326)` para polígonos, GIST en todas.
- Accesibilidad mínima: controles ≥ 44 px, texto ≥ 16 px, contraste AA, foco visible, prioridad legible sin color.
- Shell con prefijo `rtk`. Next 16 tiene cambios: leer `node_modules/next/dist/docs/` antes de escribir rutas o server actions.

## Review Focus

1. **Reintento de confirmación**: dos POST `confirm` con la misma clave devuelven el mismo `public_code` y un solo job. Test en Tarea 6.
2. **Evaluación obsoleta**: el worker termina `evaluate_report` sobre revisión 2 cuando el reporte ya está en 3; no se persiste y se reencola. Test en Tarea 8.
3. **Fuego activo vs contenedor quemado**: `active_hazard = true` exige unidad con capacidad `fuego`; una cuadrilla de limpieza nunca es candidata. Test en Tarea 12.
4. **Capacidad concurrente**: dos `applyPlan` simultáneos sobre la misma unidad de capacidad 1 crean una sola orden. Test en Tarea 12.
5. **Override sobrevive**: override de severidad + nueva reevaluación de Jev ⇒ `incidents.severity` sigue siendo el override y `changes` registra la discrepancia. Test en Tarea 10.

## Estructura de archivos

```
package.json, pnpm-lock.yaml, next.config.ts, tsconfig.json, vitest.config.ts, .env.example
Dockerfile.web, Dockerfile.worker, railway.json
migrations/0001_extensions_config.sql … 0006_system.sql
seeds/catalog.ts  seeds/policies.ts  seeds/templates.ts  seeds/territory-montevideo.ts  seeds/demo-units.ts  seeds/demo-users.ts
scripts/cli.ts            # migrate | seed | import-areas | seed-demo | reset-demo | refresh-demo-positions | smoke-jev | smoke-llm
src/worker/index.ts
src/shared/contracts/*.ts # Zod: report, message, evaluation, incident, plan, assignment, review
src/server/db/{pool,tx,migrate,sql}.ts
src/server/config/{policies,catalog,templates}.ts
src/server/access/{citizen-session,internal-session,authorize}.ts
src/server/storage/{adapter,local,supabase}.ts  src/server/storage/normalize-image.ts
src/server/ai/jev/{client,evaluate-report,compare-candidates,assess-incident,thresholds}.ts
src/server/ai/llm/{client,extract-address,clarify,interpret-correction,generate-text}.ts
src/server/geo/{locate,geocoder,nominatim}.ts
src/server/intake/{drafts,messages,orchestrator,branches,confirm}.ts
src/server/jobs/{queue,worker-loop}.ts
src/server/pipeline/{process-report,locate,group,assess,prioritize,plan,dispatch,textgen}.ts
src/server/planning/build-plan.ts        # pura
src/server/dispatch/{apply-plan,transitions}.ts
src/server/incidents/{overrides,links,queries}.ts
src/server/review/{items,resolve}.ts
src/server/events/append.ts
src/app/reportar/…  src/app/operacion/…  src/app/unidad/…  src/app/api/…
tests/unit/**  tests/db/**  tests/fixtures/**
```

## Reparto por módulos

Cada persona es dueña de un módulo: su código, sus tests y sus decisiones dentro de las interfaces del plan. Las tareas se derivan del módulo.

| Módulo | Dueño de | Tareas del plan |
| --- | --- | --- |
| **Recepción ciudadana** | `src/app/reportar`, `src/app/api/reportar`, `src/server/intake`, `src/server/ai/llm/{extract-address,clarify,interpret-correction}`, `src/server/geo/{geocoder,nominatim}`, plantillas de recepción | 5, 6, 13 y la parte de chat de la 8 |
| **Núcleo y pipeline** | `migrations`, `seeds`, `src/server/db`, `src/server/config`, `src/server/jobs`, `src/worker`, `src/server/ai/jev`, `src/server/pipeline`, `src/server/incidents`, `src/server/ai/llm/generate-text`, `scripts/cli` | 1, 2, 3, 7, pipeline de la 8, 9, 10, 15 |
| **Operación** | `src/server/access`, `src/server/storage`, `src/app/operacion`, `src/app/unidad`, `src/app/api/{operacion,unidad}`, `src/server/planning`, `src/server/dispatch`, `src/server/review` | 4, dashboard de la 8, 11, 12, 14 |

Reglas de convivencia:

- **Esquema y contratos primero.** La Tarea 1 (esquema, migrador, `src/shared/contracts`) se hace antes de que los módulos arranquen y es compartida. Un cambio de esquema o de contrato después de eso se avisa al equipo y se migra; nunca se hace en silencio.
- **Los módulos se hablan por la base y por los servicios de dominio**, no por imports cruzados de UI. Recepción escribe reportes y encola jobs; Núcleo los procesa y deja incidentes, planes y `review_items`; Operación los lee y llama a los servicios de overrides, vínculos, despacho y resolución. Las firmas exactas están en los bloques **Interfaces** de cada tarea y son el contrato entre módulos.
- **Cada módulo tiene su propio recorrido de prueba** y además participa del recorrido integrado de los hitos.
- Esta sesión (Claude) toma **Núcleo y pipeline**, con una persona pareando en Jev y calibración; las otras dos toman Recepción y Operación.

Hitos: **h+3** Tarea 8 desplegada (reporte → incidente en dashboard); **h+6** Tarea 10; **h+9** Tarea 12; **h+11** congelar.

---

### Task 1: Scaffold, base de datos y migrador

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `next.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`
- Create: `src/server/db/pool.ts`, `src/server/db/tx.ts`, `src/server/db/migrate.ts`, `scripts/cli.ts`
- Create: `migrations/0001_extensions_config.sql` … `migrations/0006_system.sql` (una por contexto del §6 del diseño)
- Test: `tests/db/setup.ts`, `tests/db/migrate.test.ts`

**Interfaces:**
- Produces: `getPool(): Pool`; `withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>`; `migrate(pool): Promise<string[]>` (nombres aplicados); tabla `schema_migrations(name pk, applied_at)`.
- Produces: `tests/db/setup.ts` exporta `testDb()` que crea/trunca `radar_urbano_test`, corre `migrate` y devuelve el pool.

- [ ] **Step 1:** Copiar el scaffold de `create-next-app@16.4.2` (ya generado en el scratchpad de la sesión, o regenerar con `--ts --app --src-dir --tailwind --eslint --use-pnpm`). Agregar dependencias: `pg @types/pg zod @typesafe-ai/sdk openai sharp iron-session leaflet react-leaflet @types/leaflet bcryptjs`; dev: `vitest tsx dotenv`. Scripts: `dev`, `build`, `start`, `worker` (`tsx src/worker/index.ts`), `cli` (`tsx scripts/cli.ts`), `test` (`vitest run`).
- [ ] **Step 2:** `.env.example` con `DATABASE_URL`, `DATABASE_URL_TEST`, `TYPESAFE_API_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `SESSION_SECRET`, `STORAGE_DRIVER=local|supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`, `NOMINATIM_USER_AGENT`. Crear `.env` local apuntando a `postgres://localhost/radar_urbano` y `radar_urbano_test`.
- [ ] **Step 3:** Test `migrate.test.ts`: `migrate` sobre base vacía devuelve ≥ 6 nombres; segunda llamada devuelve `[]`; `select postgis_version()` responde; `to_regclass('review_items')` no es null.
- [ ] **Step 4:** Correr `pnpm test` → falla (módulos inexistentes).
- [ ] **Step 5:** Implementar `pool.ts` (pool por `DATABASE_URL`, `max` 10, `ssl` si la URL no es localhost), `tx.ts`, `migrate.ts` (lee `migrations/*.sql` ordenados, aplica cada uno en transacción con advisory lock `pg_advisory_lock(727)`).
- [ ] **Step 6:** Escribir las seis migraciones con exactamente las tablas, enums (como `check`), índices únicos parciales e índices GIST del §6 del diseño. `0001` incluye `create extension if not exists postgis; create extension if not exists pgcrypto;`.
- [ ] **Step 7:** `scripts/cli.ts` con subcomando `migrate`. Correr `pnpm cli migrate` contra `radar_urbano` y `pnpm test` → PASS.
- [ ] **Step 8:** Commit `feat: scaffold, migrador y esquema PostGIS`.

### Task 2: Adaptador Jev y `evaluateReport` con prueba real

**Files:**
- Create: `src/server/ai/jev/client.ts`, `src/server/ai/jev/thresholds.ts`, `src/server/ai/jev/evaluate-report.ts`, `src/shared/contracts/evaluation.ts`, `scripts/smoke-jev.ts`
- Test: `tests/unit/thresholds.test.ts`, `tests/unit/evaluate-report.mapping.test.ts`, `tests/fixtures/jev/*.json`

**Interfaces:**
- Produces: `ReportEvaluationSchema` (Zod) con los campos de `report_evaluations` del §6.3 más `answers` crudo.
- Produces: `evaluateReport(input: { reportId; reportRevision; messages: {id; body; createdAt}[]; images: {attachmentId; bytes: Buffer; format: 'jpeg'|'png'}[]; locationConfirmed: boolean; catalog: {slug; name; criteria: unknown}[]; catalogHash: string; policy: EvaluationPolicy }, deps: { jev: JevClient; recordRun: (run) => Promise<string> }): Promise<{ ok: true; value: ReportEvaluation; aiRunId: string } | { ok: false; error: AiError; aiRunId?: string }>`.
- Produces: `meetsThreshold(answer: ChoiceAnswer, favorable: string[], min: number): boolean`; `noulVerdict(p: number, band: number): 'yes'|'no'|'uncertain'`.
- Produces: `JevClient` = `TypeSafeClient` configurado con `defaultModel` de política, `timeout`, `retry.maxRetries = 1` (el worker reintenta), header de imágenes cuando hay imágenes.

- [ ] **Step 1:** Tests de `thresholds`: `meetsThreshold({choice:'applicable', probabilities:{applicable:0.93,…}}, ['applicable'], 0.9)` → true; misma probabilidad con `choice:'unrelated'` → false; `noulVerdict(0.52, 0.1)` → `'uncertain'`.
- [ ] **Step 2:** Test de mapeo: dado un fixture de respuesta `systemOne` (shape documentado: `answers.{intent,applicability,problem_type,severity,active_fire,passage,accessibility,location_in_text,photo_quality,text_photo_consistency}` con `choice/probabilities/confidence`), `evaluateReport` devuelve `needs_review = true` con `review_reasons` incluyendo `contradiction` cuando `text_photo_consistency.choice = 'contradiction'`; rechaza con error tipado si `problem_type.choice` no está en el catálogo ∪ `{other, unknown}`.
- [ ] **Step 3:** Correr → falla.
- [ ] **Step 4:** Implementar `client.ts`, `thresholds.ts`, `evaluate-report.ts`. El `state` enviado: `{ report: { messages: [{id, text}], photos: {<attachmentId>: image(...)}, location_confirmed } , catalog: [{slug, name, criteria}] }`. Las preguntas son las diez Choice del §5.2 (criterios de `problem_type` = catálogo + `other` + `unknown`) más los Noul de `policy.noul_facts`. Guardar request (sin bytes) y response en `ai_runs` vía `recordRun`.
- [ ] **Step 5:** `scripts/smoke-jev.ts`: lee `TYPESAFE_API_KEY`; corre tres casos de `tests/fixtures/jev/cases/` (texto solo, texto + foto, mensaje ajeno) y escribe respuestas crudas en `tests/fixtures/jev/responses/<caso>.json` con `model_returned`, `latency_ms` y `usage`. **Bloqueado hasta tener la clave**; si falta, el script termina con mensaje claro y código 2.
- [ ] **Step 6:** Correr tests unitarios → PASS. Correr `pnpm cli smoke-jev` cuando exista la clave; registrar en `docs/superpowers/notes/jev-smoke.md` modelo devuelto, latencias y observaciones (español, fotos). Ajustar umbrales iniciales de seed si hace falta.
- [ ] **Step 7:** Commit `feat: adaptador Jev y evaluateReport`.

### Task 3: Seeds de configuración y territorio Montevideo

**Files:**
- Create: `seeds/catalog.ts`, `seeds/policies.ts`, `seeds/templates.ts`, `seeds/territory-montevideo.ts`, `src/server/config/{catalog,policies,templates}.ts`, `src/server/geo/import-areas.ts`
- Modify: `scripts/cli.ts` (subcomandos `seed`, `import-areas`)
- Test: `tests/db/seeds.test.ts`, `tests/db/geo.test.ts`

**Interfaces:**
- Produces: `seedAll(pool)`; `importAreas(pool, { territorySlug; file; nameProperty: 'barrio'; idProperty: 'ogc_fid'; sourceUrl })`.
- Produces: `getActivePolicy<K extends PolicyKind>(client, territoryId, kind): Promise<PolicyOf<K>>` (Zod por kind, falla si no hay activa); `getActiveCatalog(client, territoryId): Promise<{ types; hash }>`; `renderTemplate(client, territoryId, key, vars): Promise<string>`.
- Produces: `locatePoint(client, lon, lat): Promise<{ territoryId; areaId: string|null; areaName: string|null } | null>` usando `ST_Contains` sobre `areas.geom`, y cobertura = `territories.coverage` o `ST_Union(areas.geom)`.

- [ ] **Step 1:** Tests: `seedAll` dos veces ⇒ mismos conteos de `problem_types` (10), `capabilities`, `policy_versions` (7 activas para Montevideo), `message_templates`; modificar `problem_types.name` de un tipo y volver a seedear ⇒ el nombre modificado se conserva. `importAreas` ⇒ 62 filas, segunda corrida 62. `locatePoint(-56.1645, -34.9011)` (Plaza Independencia) ⇒ `areaName = 'CIUDAD VIEJA'` (verificar el nombre exacto en el GeoJSON antes de fijar la aserción); punto en el Río de la Plata ⇒ `null`.
- [ ] **Step 2:** Correr → falla.
- [ ] **Step 3:** Escribir seeds con los valores iniciales del ALCANCE y del §7 del diseño: catálogo de 10 tipos con `evaluation_criteria` por tipo (una línea “qué es / qué no es / ejemplos” en español), capacidades `limpieza vialidad fuego alumbrado poda accesibilidad señalizacion drenaje`, `problem_type_requirements` (fuego activo → `fuego` con `active_hazard`), políticas `intake/evaluation/grouping/priority/planning/dispatch/textgen`, plantillas `greeting_other`, `ask_location`, `ask_better_photo`, `status_card`, `confirmation`, `pending_analysis`. Territorio `montevideo` con `area_label = 'Barrio'`, centro y `emergency_channel` tomado de configuración (texto genérico “consultá el canal de emergencias local”, sin teléfono inventado).
- [ ] **Step 4:** Implementar `import-areas.ts` con `ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON($1)), 4326)`, checksum sha256 del archivo, `on conflict (territory_id, external_id) do nothing`.
- [ ] **Step 5:** Correr tests → PASS. `pnpm cli seed && pnpm cli import-areas --territory montevideo --file barrios-montevideo.geojson`.
- [ ] **Step 6:** Commit `feat: seeds de configuración, importador de áreas y localización PostGIS`.

### Task 4: Acceso y storage

**Files:**
- Create: `src/server/access/citizen-session.ts`, `src/server/access/internal-session.ts`, `src/server/access/authorize.ts`, `src/server/storage/{adapter,local,supabase,normalize-image}.ts`, `seeds/demo-users.ts`, `src/app/(internal)/login/page.tsx`, `src/app/api/auth/login/route.ts`
- Test: `tests/unit/normalize-image.test.ts`, `tests/db/access.test.ts`

**Interfaces:**
- Produces: `getOrCreateCitizenSession(cookies): Promise<{ id }>` (token opaco aleatorio, `token_hash` sha256 en base); `getInternalSession(cookies): Promise<{ userId; role; territoryId; responseUnitId? } | null>`; `requireOperator(territoryId)`, `requireUnit(unitId)` lanzan 403.
- Produces: `StorageAdapter { put(key, bytes, contentType); get(key); signedUrl(key, ttlSec) }` con `local` (directorio `storage/`, servido por ruta autorizada) y `supabase` (bucket privado, `createSignedUrl`).
- Produces: `normalizeForJev(bytes): Promise<{ bytes; width; height; format: 'jpeg' }>`: aplica EXIF, convierte a JPEG baseline, lado mayor ≤ 1568 y menor ≥ 280 (padding si hace falta).

- [ ] **Step 1:** Tests: una foto vertical 3000×4000 con EXIF orientación 6 ⇒ salida 1176×1568 o 1568×1176 con píxeles rotados (comparar esquina); una imagen 200×200 ⇒ ≥ 280 por lado. Sesión ciudadana: dos requests con la misma cookie ⇒ mismo `id`; operador de Montevideo pidiendo un territorio ajeno ⇒ 403.
- [ ] **Step 2:** Correr → falla.
- [ ] **Step 3:** Implementar. Contraseñas de demo con `bcryptjs`; valores por entorno `DEMO_OPERATOR_PASSWORD`, `DEMO_UNIT_PASSWORD` (la seed falla si faltan). `iron-session` con `SESSION_SECRET`.
- [ ] **Step 4:** Tests → PASS. Commit `feat: sesiones, autorización y storage con normalización de imágenes`.

### Task 5: Persistencia de recepción y API de borrador

**Files:**
- Create: `src/shared/contracts/{report,message}.ts`, `src/server/intake/{drafts,messages}.ts`, `src/server/events/append.ts`, `src/app/api/reportar/{drafts,drafts/[id]/messages,drafts/[id]/attachments,drafts/[id]/location}/route.ts`
- Test: `tests/db/intake.test.ts`

**Interfaces:**
- Produces: `createDraft(client, { sessionId; territoryId }): Promise<Report>` (crea `reports` + `conversations`); `listMyReports(client, sessionId)`; `appendCitizenMessage(client, { reportId; sessionId; clientMessageId; body }): Promise<{ message; report; duplicate: boolean }>` (sube `reports.revision` salvo duplicado); `attachPhoto(client, storage, { reportId; sessionId; bytes; contentType })` guarda original + derivado `purpose='jev'`, sube revisión; `setLocation(client, { reportId; sessionId; lon; lat; source; text? })` sube revisión y marca `location_confirmed`.
- Produces: `appendEvent(client, { entityType; entityId; kind; actorType; actorId?; data })`.

- [ ] **Step 1:** Tests: mismo `clientMessageId` dos veces ⇒ un solo `messages` y `duplicate = true`, revisión no sube; un borrador de otra sesión ⇒ error 403 tipado; `setLocation` ⇒ `ST_Y(location::geometry)` ≈ lat.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar. **Step 4:** Tests → PASS. Commit `feat: persistencia de recepción`.

### Task 6: Orquestador de recepción (Jev primero) y confirmación

**Files:**
- Create: `src/server/intake/{orchestrator,branches,confirm}.ts`, `src/server/jobs/queue.ts`, `src/app/api/reportar/drafts/[id]/confirm/route.ts`
- Modify: `src/app/api/reportar/drafts/[id]/messages/route.ts` (llama al orquestador tras persistir)
- Test: `tests/unit/branches.test.ts`, `tests/db/confirm.test.ts`

**Interfaces:**
- Produces: `enqueue(client, { kind; entityType; entityId; entityRevision; territoryId?; payload? }): Promise<{ id; created: boolean }>` con `dedupe_key = kind:entityType:entityId:entityRevision`.
- Produces: `chooseBranch(evaluation: ReportEvaluation, report: Report, policy: IntakePolicy, rounds: number): Branch` donde `Branch = { kind: 'orient' } | { kind: 'status' } | { kind: 'ask_location' } | { kind: 'extract_address' } | { kind: 'ask_evidence' } | { kind: 'interpret_correction' } | { kind: 'ready' }`. Pura.
- Produces: `runIntakeTurn(client, deps, { reportId }): Promise<{ assistantMessage: Message; branch: Branch; evaluation?: ReportEvaluation }>`: carga estado, llama a `evaluateReport` con timeout de política; si expira o falla ⇒ plantilla `pending_analysis` y `enqueue('evaluate_report')`; si responde ⇒ guarda `report_evaluations(report_id, report_revision)`, aplica rama. En esta tarea las ramas que requieren LLM responden con plantilla y botones (Tarea 13 las completa).
- Produces: `confirmReport(client, { reportId; sessionId; idempotencyKey }): Promise<{ publicCode; jobId }>`: transacción; si ya confirmado devuelve lo mismo; genera `public_code` corto único; `enqueue('process_report', reportId, confirmed_revision)`.

- [ ] **Step 1:** Tests de `chooseBranch` con evaluaciones fixture: `intent=other` ⇒ `orient`; `report` + `location_in_text=absent` + sin ubicación ⇒ `ask_location`; `precise` sin ubicación ⇒ `extract_address`; `photo_quality=insufficient` y `rounds < max` ⇒ `ask_evidence`; `rounds = max` ⇒ `ready` con `needs_review`; todo presente ⇒ `ready`.
- [ ] **Step 2:** Test de confirmación: dos llamadas con la misma clave ⇒ mismo `publicCode`, un solo `jobs`; confirmar un borrador sin ubicación confirmada ⇒ error tipado `location_required`.
- [ ] **Step 3:** Correr → falla. **Step 4:** Implementar. **Step 5:** Tests → PASS. Commit `feat: orquestador Jev-primero y confirmación idempotente`.

### Task 7: Worker y cola de jobs

**Files:**
- Create: `src/server/jobs/worker-loop.ts`, `src/worker/index.ts`
- Modify: `src/server/jobs/queue.ts`
- Test: `tests/db/jobs.test.ts`

**Interfaces:**
- Produces: `claimNext(client, workerId, leaseSec): Promise<Job | null>` (`FOR UPDATE SKIP LOCKED`, `status='pending' and run_after <= now()` o `running and lease_until < now()`); `completeJob(client, id)`; `failJob(client, id, error, backoff)` (`attempts+1`, `run_after = now() + base * 2^attempts`, `failed` al agotar); `runWorker({ handlers: Record<kind, Handler>; workerId })` con heartbeat que renueva lease y `pg_advisory_xact_lock(hashtext(territory_id))` para kinds marcados `serializeByTerritory`.
- Produces: al pasar a `failed`, crea `review_items(kind='provider_failure')` sobre la entidad.

- [ ] **Step 1:** Tests: dos `claimNext` concurrentes sobre un job ⇒ uno recibe `null`; job con `lease_until` vencido se reclama de nuevo; `failJob` tres veces con `max_attempts = 3` ⇒ `failed` y un `review_items` abierto; `enqueue` duplicado ⇒ `created = false`.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar. **Step 4:** Tests → PASS. Commit `feat: cola de jobs con lease y worker`.

### Task 8: Primera sección funcional: `process_report` → incidente → dashboard → desplegado

**Files:**
- Create: `src/server/pipeline/{process-report,locate}.ts`, `src/server/incidents/queries.ts`, `src/app/reportar/[territory]/page.tsx` + componentes de chat (`Chat.tsx`, `LocationPicker.tsx` con Leaflet, `DraftCard.tsx`), `src/app/operacion/page.tsx` (lista) y `src/app/api/operacion/incidents/route.ts`, `Dockerfile.web`, `Dockerfile.worker`, `railway.json`
- Test: `tests/db/process-report.test.ts`

**Interfaces:**
- Produces: handler `process_report(job)`: reutiliza `report_evaluations` si `report_revision = confirmed_revision` y `catalog_hash`/`policy_version_id` coinciden, si no llama `evaluateReport`; si la revisión del reporte cambió respecto del job ⇒ descarta y `enqueue` con la nueva; `locate` ⇒ `territory_id/area_id` o `outcome = out_of_coverage` + `review_items(out_of_coverage)`; `applicability = unrelated` ⇒ `outcome = unrelated`, fin; `insufficient` ⇒ `review_items(insufficient_evidence)`; aplicable ⇒ **en esta tarea** crea incidente nuevo siempre (Tarea 9 agrega agrupación), `report_incident_links`, `events`, y encola `assess_incident`.
- Produces: `listIncidents(client, territoryId, filters: { areaId?; problemTypeId?; priorityBand?; status?; sort })`.

- [ ] **Step 1:** Test: reporte confirmado con evaluación válida de fixture ⇒ `incidents` 1, `report_incident_links` activo 1, `incidents.area_id` resuelto; job sobre revisión vieja ⇒ no crea incidente y existe un nuevo job con la revisión actual.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar handler, páginas mínimas (chat con envío de texto/foto, selector de ubicación con botones “Usar mi ubicación / Elegir en el mapa / Escribir dirección”, ficha, botón Enviar, código y estado; lista de incidentes con filtros por barrio/tipo/prioridad/estado). **Step 4:** Tests → PASS.
- [ ] **Step 5:** Recorrido manual local: web + worker corriendo, reportar desde el celular por LAN, ver el incidente en `/operacion`. Documentar en `docs/superpowers/notes/recorrido-1.md` qué se vio.
- [ ] **Step 6:** Despliegue: Supabase con PostGIS (`create extension postgis` desde el dashboard SQL), `DATABASE_URL` en modo sesión, bucket privado; Railway con dos servicios desde el repo (`web`: `pnpm build && pnpm start`; `worker`: `pnpm worker`), variables de entorno, `pnpm cli migrate && pnpm cli seed && pnpm cli import-areas` ejecutados una vez. Verificar desde celular real por internet.
- [ ] **Step 7:** Commit `feat: process_report, chat ciudadano, lista del operador y despliegue`. **Hito h+3.**

### Task 9: Agrupación automática

**Files:**
- Create: `src/server/ai/jev/compare-candidates.ts`, `src/server/pipeline/group.ts`, `src/server/incidents/links.ts`
- Modify: `src/server/pipeline/process-report.ts`
- Test: `tests/unit/compare-candidates.mapping.test.ts`, `tests/db/group.test.ts`

**Interfaces:**
- Produces: `findCandidates(client, { territoryId; lon; lat; radiusM; limit })` con `ST_DWithin(location, ST_MakePoint($lon,$lat)::geography, $r)` sobre `incidents.status in (open, assigned, in_progress)`, ordenado por distancia.
- Produces: `compareCandidates(input: { report: {…evidencia}; candidates: { incidentId; distanceM; summary; evidence }[]; policy })`: una llamada Jev con, por candidato, Choice `match_<id>: same_incident|different_incident|uncertain` y Noul `object_conflict_<id>`, `place_conflict_<id>`, `time_conflict_<id>`. Devuelve `{ outcome; chosenIncidentId?; perCandidate }`.
- Produces: `decideGrouping(perCandidate, policy): 'link' | 'create' | 'review'` pura: `link` si exactamente un `same` ≥ `same_threshold` sin Noul de conflicto > banda y el resto `different` ≥ `different_threshold`; `create` si todos `different`; `review` en otro caso o si `truncated`.
- Produces: `linkReport(client, { reportId; incidentId; origin; decisionId; actorId? })`, `unlinkReport(client, { reportId; reason; actorId })` (desactiva vínculo, reevalúa ambos; si el incidente queda vacío ⇒ `archived` + cancela orden activa).

- [ ] **Step 1:** Tests de `decideGrouping`: un `same` 0.95 + un `different` 0.92 ⇒ `link`; dos `same` ⇒ `review`; un `same` 0.95 con `place_conflict = 0.8` ⇒ `review`; sin candidatos ⇒ `create`. Test DB: dos incidentes a 10 m y un reporte con fixture `same` para el primero ⇒ vínculo al primero, `reports.grouping = linked`, job `assess_incident` encolado; `unlinkReport` del único reporte ⇒ incidente `archived`.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar e integrar en `process_report` (candidatos → comparar → decidir). **Step 4:** Tests → PASS. Commit `feat: agrupación automática con Jev`.

### Task 10: Reevaluación del incidente, overrides y prioridad

**Files:**
- Create: `src/server/ai/jev/assess-incident.ts`, `src/server/pipeline/{assess,prioritize}.ts`, `src/server/incidents/overrides.ts`, `src/shared/contracts/incident.ts`
- Test: `tests/unit/prioritize.test.ts`, `tests/db/assess.test.ts`

**Interfaces:**
- Produces: `assessIncident(input: { incident; reports: {…evidencia original}[]; previous?: IncidentAssessment; counts: { messages; sources; repeated }; policy })` ⇒ Choice `problem_type`, `severity`, `active_hazard`, `evolution: worsened|same|improved|undetermined` y Noul de evidencia nueva. `counts` los calcula el backend: `sources` = sesiones distintas; `repeated` = adjuntos con mismo `sha256`.
- Produces: `applyOverrides(assessment, overrides): { effective; discrepancies }` pura; handler `assess_incident` guarda `incident_assessments`, actualiza columnas efectivas del incidente, sube `revision`, encola `prioritize`.
- Produces: `computePriority(effective: { severity; activeHazard; passage; accessibility }, createdAt, now, policy): { band; breakdown }` pura con las reglas del ALCANCE §4 (alta por severidad alta / fuego / bloqueo total / accesibilidad confirmada; media por severidad media o baja > 48 h; baja).
- Produces: `setOverride(client, { incidentId; field; value; reason; actorId })`, `removeOverride(...)`; ambos encolan `assess_incident` y, si hay orden activa y el campo es tipo/ubicación, marcan `assignments.review_blocked` + `review_items(incompatible_assignment)`.

- [ ] **Step 1:** Tests de `computePriority`: fuego activo ⇒ `high` aunque severidad `low`; `low` creada hace 49 h ⇒ `medium` con `breakdown.promoted_by_age = true`; `medium` ⇒ `medium`. Test DB: override `severity = low` + nueva evaluación `high` ⇒ `incidents.severity = 'low'`, `incident_assessments.changes` contiene `{ field: 'severity', assessed: 'high', effective: 'low', override: true }`.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar. **Step 4:** Tests → PASS. Commit `feat: reevaluación, overrides y prioridad`. **Hito h+6.**

### Task 11: Planificador determinista

**Files:**
- Create: `src/server/planning/build-plan.ts`, `src/server/pipeline/plan.ts`, `src/shared/contracts/plan.ts`, `src/app/operacion/plan/page.tsx`, `src/app/api/operacion/plan/route.ts`
- Test: `tests/unit/build-plan.test.ts`

**Interfaces:**
- Produces: `buildPlan(snapshot: { incidents: { id; band; activeHazard; createdAt; sourcesInWindow; dispatchBlocked; requiredCapabilities: string[]; location?: {lon;lat}; areaId?; revision }[]; units: { id; kind; capabilities: string[]; capacity; activeOrders; location?; locationUpdatedAt?; serviceRadiusM?; zoneResponsibilities: { areaId; problemTypeId; precedence }[] }[]; activeAssignments: { incidentId; unitId }[]; strategies: Record<problemTypeId, 'nearest_mobile'|'zone_owner'|'manual'> }, policy: PlanningPolicy & DispatchPolicy, now: Date): { queue: PlanItem[]; proposals: { incidentId; unitId; distanceM?; reasons: string[] }[]; pending: { incidentId; reasons: string[] }[] }`. Pura, determinista, sin IO.
- Orden: `activeHazard desc, bandRank, score desc, createdAt asc, id asc`, `score = waitHours + min(cap, weight * log2(max(1, sources)))`. Asignación voraz con costo de oportunidad (número de otros incidentes que perderían su única unidad factible), luego distancia (móviles) o precedencia/carga (zona), luego id. Incidentes con orden activa o `dispatchBlocked` entran en la cola pero no reciben propuesta.
- Produces: handler `plan(territoryId)` que arma el snapshot desde base, persiste `plan_runs` + `plan_items`, marca ítems del plan anterior `obsolete`, y encola `dispatch`.

- [ ] **Step 1:** Tests con fixtures en memoria: (a) ejemplo del ALCANCE: unidad polivalente (basura+bache) y unidad solo basura, un bache y una basura de igual banda ⇒ la de limpieza va a basura y la polivalente al bache aunque esté más cerca del contenedor; (b) 4 fuentes/3 h adelanta a 1 fuente/6 h en la misma banda; (c) fuego con 1 fuente precede a basura con 100; (d) fuego sin unidad con capacidad `fuego` ⇒ `pending` con razón `no_capable_unit` y la cuadrilla de limpieza no se propone; (e) unidad con posición de hace 40 min ⇒ `stale_position`; (f) zona sin GPS recibe por `area_responsibilities`; (g) mismo snapshot dos veces ⇒ resultado idéntico; (h) bonus saturado: 1000 fuentes ⇒ `cap`.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar `build-plan.ts`, handler y vista “Plan de atención” (orden, incidente, banda, espera, fuentes, bonus, unidad propuesta/asignada, razón, bloqueo, versión y hora; botón “Actualizar plan”). **Step 4:** Tests → PASS. Commit `feat: planificador determinista y vista de plan`.

### Task 12: Despacho transaccional y bandeja de unidad

**Files:**
- Create: `src/server/dispatch/{apply-plan,transitions}.ts`, `src/server/pipeline/dispatch.ts`, `src/shared/contracts/assignment.ts`, `src/app/unidad/page.tsx`, `src/app/api/unidad/assignments/[id]/route.ts`
- Test: `tests/db/dispatch.test.ts`

**Interfaces:**
- Produces: `applyPlan(pool, planRunId)`: por propuesta en orden, transacción: `select … for update` de incidente y unidad; revalida `incident.revision`, `dispatch_blocked = false`, sin orden activa, `count(active) < capacity`, capacidades requeridas ⊆ capacidades de la unidad (incluida `active_hazard`), vigencia de posición y radio según estrategia; inserta `assignments(status='offered')`, `incidents.status='assigned'`, `plan_items.status='executed'`, `events`. Si la revisión cambió ⇒ detiene y encola `plan`.
- Produces: `transitionAssignment(client, { assignmentId; action: 'accept'|'reject'|'start'|'complete'|'cancel'; actor: { type; id; unitId? }; expectedVersion; reason? })`: verifica que la unidad de la sesión sea la de la orden; `review_blocked` impide `start/complete`; `complete` ⇒ incidente `resolved`; `reject/cancel` ⇒ incidente `open` + `dispatch_blocked` + `review_items(rejected_assignment)`; cualquier transición encola `plan`.

- [ ] **Step 1:** Tests: dos `applyPlan` concurrentes (Promise.all) con una unidad de capacidad 1 y dos incidentes ⇒ exactamente una orden; incidente con `active_hazard` y única unidad sin `fuego` ⇒ sin orden y `plan_items.blocked_reason = no_capable_unit`; `accept` desde otra unidad ⇒ 403; `reject` ⇒ `dispatch_blocked = true`, `review_items` abierto, y un nuevo `plan` no propone ese incidente; `complete` ⇒ `resolved` y la unidad vuelve a tener capacidad.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar, más bandeja `/unidad` (tarjetas grandes: tipo, prioridad y motivo, dirección, barrio, mapa pequeño, descripción, fotos firmadas; botones Aceptar / Rechazar / Iniciar / Completar; polling cada 10 s). **Step 4:** Tests → PASS. Probar desde celular en producción. Commit `feat: despacho transaccional y bandeja de unidad`. **Hito h+9.**

### Task 13: LLM bajo demanda en recepción y geocodificación

**Files:**
- Create: `src/server/ai/llm/{client,extract-address,clarify,interpret-correction}.ts`, `src/server/geo/{geocoder,nominatim}.ts`, `scripts/smoke-llm.ts`
- Modify: `src/server/intake/branches.ts` / `orchestrator.ts` (ramas `extract_address`, `ask_evidence`, `interpret_correction` pasan a usar LLM con fallback a plantilla)
- Test: `tests/unit/llm-contracts.test.ts`, `tests/db/geocode-cache.test.ts`

**Interfaces:**
- Produces: `llmClient` = `OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY })` contra el modelo open source servido en Tenki; cada llamada usa `chat.completions` con `response_format: { type: 'json_schema', json_schema }` y valida la salida con Zod (si no valida ⇒ `{ ok: false }`), registra `llm_runs`, timeout y `max_output_tokens` de política; cualquier error ⇒ `{ ok: false }` y el orquestador usa plantilla.
- Produces: `extractAddress({ messages, territoryName }) → { address: string|null; sourceMessageIds: string[] }`; `clarify({ evaluation, missing, messages }) → { question; requestedField }`; `interpretCorrection({ messages, draft }) → { proposedFields: Partial<{ description; locationText }>; sourceMessageIds }`. Se valida que `sourceMessageIds ⊆` ids reales.
- Produces: `geocode(client, { query; territory }) → { lon; lat; label } | null` con caché en `geocode_cache`, `User-Agent` de entorno, 1 req/s, `viewbox` del territorio y `bounded=1`.

- [ ] **Step 1:** Tests: `sourceMessageIds` con un id inexistente ⇒ rechazo tipado; `geocode` dos veces la misma consulta ⇒ una sola llamada al proveedor (inyectar `fetch`). Smoke `pnpm cli smoke-llm` **bloqueado hasta tener el endpoint de Tenki**: tres mensajes rioplatenses con dirección (“en Rivera y Comercio”, “frente al 1234 de 18 de julio”, “acá en la esquina de casa”) y registrar salidas y latencia en `docs/superpowers/notes/llm-smoke.md`; fijar el modelo definitivo en la seed de `textgen`.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar; en el chat, la dirección extraída se muestra como pin propuesto que la persona confirma o mueve. **Step 4:** Tests → PASS. Commit `feat: LLM bajo demanda y geocodificación con caché`.

### Task 14: Cola de revisión y detalle del incidente

**Files:**
- Create: `src/server/review/{items,resolve}.ts`, `src/shared/contracts/review.ts`, `src/app/operacion/revision/page.tsx`, `src/app/operacion/incidentes/[id]/page.tsx`, rutas API de revisión, overrides, asociar/desasociar y resolver
- Test: `tests/db/review.test.ts`

**Interfaces:**
- Produces: `openReviewItem(client, { territoryId; kind; entityType; entityId; reasons; evidenceRefs })` (idempotente por `(kind, entity_type, entity_id) where status='open'`; al abrir sobre un incidente ⇒ `dispatch_blocked = true`); `resolveReviewItem(client, { id; actorId; resolution: { action: 'link'|'create_incident'|'set_type'|'set_severity'|'allow_dispatch'|'dismiss'|'reassign'; … } })` aplica la acción con los servicios de Tareas 9–12, cierra el ítem, recalcula `dispatch_blocked` (false si no quedan ítems abiertos) y encola `assess_incident`/`plan`.
- UI: cola ordenada por banda y antigüedad con motivo legible; detalle con fotos, descripción original, evaluación con evidencia, reportes asociados (asociar/desasociar), historial de `events`, acciones Corregir datos / Marcar en atención / Marcar resuelto (cierra orden activa en la misma transacción).

- [ ] **Step 1:** Tests: abrir dos veces el mismo ítem ⇒ uno; resolver con `allow_dispatch` ⇒ `dispatch_blocked = false` y job `plan`; resolver `uncertain_duplicate` con `link` ⇒ vínculo activo y `assess_incident` para el incidente.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar. **Step 4:** Tests → PASS. Commit `feat: cola de revisión y detalle del incidente`.

### Task 15: Textos generados, demo y verificación final

**Files:**
- Create: `src/server/ai/llm/generate-text.ts`, `src/server/pipeline/textgen.ts`, `seeds/demo-units.ts`, `seeds/territory-demo-b.ts` (segundo territorio sintético solo para test), `scripts/cli.ts` (`seed-demo`, `reset-demo`, `refresh-demo-positions`)
- Test: `tests/db/second-territory.test.ts`, `tests/db/demo-seeds.test.ts`

**Interfaces:**
- Produces: `generateText({ purpose: 'title'|'summary'|'explain_priority'|'explain_plan'; facts; references; entityRevision })` cacheado en `generated_texts`; handler `textgen` encolado tras `assess_incident` y `plan`; UI muestra plantilla si no hay texto aún.
- Produces: seed de demo con tres cuadrillas móviles de Montevideo (limpieza; vialidad+limpieza; fuego+limpieza) con posiciones marcadas `is_demo`, y una unidad `zone_office` con `area_responsibilities` para `alumbrado` en dos barrios; `refresh-demo-positions` actualiza `location_updated_at = now()` solo en `is_demo`; `reset-demo` borra reportes/incidentes/órdenes/planes/review/jobs y conserva configuración.
- Produces: test de segundo territorio: seed `demo-b` con un polígono cuadrado y una unidad; un punto dentro se localiza en `demo-b` y su plan solo considera unidades de `demo-b`.

- [ ] **Step 1:** Tests: `seed-demo` dos veces ⇒ 4 unidades; cambiar `capacity` de una y reseedear ⇒ se conserva; segundo territorio según arriba.
- [ ] **Step 2:** Correr → falla. **Step 3:** Implementar. **Step 4:** Tests → PASS.
- [ ] **Step 5:** Recorrido completo en producción con el guion de la demo del ALCANCE §12, con fotos reales del equipo: reporte con foto ⇒ plan ⇒ orden aceptada en otro celular ⇒ segundo reporte agrupado sin doble despacho ⇒ caso ambiguo en revisión. Anotar latencias y fallas en `docs/superpowers/notes/recorrido-final.md`. Congelar funcionalidad. **Hito h+11.**
- [ ] **Step 6:** Commit `feat: textos generados, seeds de demo y verificación final`.
