# Tarea 14 — Cola de revisión, detalle del incidente y acciones del operador — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Las Tasks 1, 2 y 3 se ejecutan en paralelo**, cada una en su rama y su PR contra `epic/revision`. La Task 3 (UI de la cola) consume la API de la Task 1: se construye contra el contrato ya existente y **se mergea después de la Task 1** (ver su Step 6).

**Goal:** Cerrar el lazo humano. Hoy todo lo que cae en revisión queda trabado: un `uncertain_duplicate` bloquea el despacho de sus candidatos, una orden rechazada deja el incidente con `dispatch_blocked`, y no hay forma de corregir tipo, severidad o banda desde la consola. Después de este plan, el operador ve la cola, abre el detalle, corrige y resuelve, y el pipeline sigue solo.

**Contexto (18 oct, `main` = `830c305`):** los servicios de Núcleo ya existen y tienen tests: `setOverride`, `removeOverride` (`src/server/incidents/overrides.ts`), `linkReport`, `unlinkReport` (`src/server/incidents/links.ts`), `openReviewItem`, `incidentsAffectedByReviewItem` y `recomputeDispatchBlocked` (`src/server/review/items.ts`). También existen los contratos `ResolveAction`, `ResolveBody`, `ReviewItemView`, `ReviewQueueResponse` (`src/shared/contracts/review.ts`), `SetOverrideBody`, `LinkBody`, `OverrideValue` (`src/shared/contracts/incident.ts`) y la firma `ResolveReviewItem` (`src/server/contracts.ts:46`). **Faltan** el dominio de resolución, las rutas API, las dos páginas y la navegación. La lista del operador ya muestra `openReviewKinds` y el contador `summary.review`.

**Architecture:**
- **Task 1 (backend de la cola):**
  - `resolveReviewItem` aplica cada acción con los servicios de dominio, nunca con updates sueltos. Cierra el ítem, recalcula `dispatch_blocked` y encola `plan`.
  - `listReviewQueue` arma `ReviewQueueResponse`.
  - `createIncidentFromReport` se extrae de `process-report.ts` para la acción `create_incident`.
  - Rutas `GET /api/operacion/review` y `POST /api/operacion/review/[id]/resolve`.
- **Task 2 (detalle):**
  - `getIncidentDetail` y su contrato `IncidentDetailResponse` en un archivo nuevo.
  - Rutas de detalle, correcciones, vínculos y fotos para el operador.
  - Página `/operacion/incidentes/[id]` con las acciones.
- **Task 3 (UI de la cola):** página `/operacion/revision`, entradas «Revisión» en la barra lateral y enlaces de la lista al detalle.

**Tech Stack:** Next.js 16 (App Router; antes de escribir rutas o páginas leer `node_modules/next/dist/docs/`, según `AGENTS.md`), TypeScript, pg, Zod, vitest, Tailwind con los tokens de la consola (`src/app/operacion/operacion.css`).

**Spec:**
- Diseño §5.4 «Lazo humano» y §6.6 `review_items` (`docs/superpowers/specs/2026-10-17-radar-urbano-design.md`).
- Plan MVP, Tarea 14 (`docs/superpowers/plans/2026-10-17-radar-urbano-mvp.md:294`).
- `ALCANCE-RADAR-URBANO.md` §«Revisión humana».

## Global Constraints

- **Ramas desde `origin/epic/revision`** (= `main` = `830c305`):
  - Task 1 en `revision/backend`.
  - Task 2 en `revision/detalle`.
  - Task 3 en `revision/cola-ui`.
- Los PRs de las tres van contra `epic/revision`. El corte `epic/revision → main` lo abre quien coordina (Task 4). **Mergear a `main` despliega a producción.**
- **Módulo:** son archivos de Operación (`src/server/review`, `src/app/operacion`, `src/app/api/operacion`), hechos por Núcleo con aviso. Cada PR lo dice en el cuerpo.
- Sin migraciones. **Contratos:**
  - No cambiar nada existente en `src/shared/contracts/*` ni en `src/server/contracts.ts`.
  - Solo la Task 2 **agrega** un archivo nuevo, `src/shared/contracts/incident-detail.ts`.
- Archivos de otra tarea **prohibidos**:
  - Task 1: no toca `src/app/operacion/**`, `src/server/incidents/detail.ts` ni las rutas de incidentes.
  - Task 2: no toca `src/server/review/**`, `src/app/api/operacion/review/**`, `src/app/operacion/revision/**` ni `OpsShell.tsx`.
  - Task 3: no toca `src/server/**` ni `src/app/api/**`. Sí puede tocar `OpsShell.tsx`, `IncidentBoard.tsx` y `labels.ts`.
- **Autorización como en las rutas existentes** (`src/app/api/operacion/assignments/[id]/route.ts`):
  - Primero `requireOperatorSession()`, antes de validar la entrada o buscar algo.
  - Después `requireOperator(s, territoryId)` con el territorio de la entidad.
  - Ids que no son uuid o ajenos ⇒ 404, nunca 403 con detalle.
  - Todo va dentro de `handle(...)` (`src/server/http.ts`).
- **Idempotencia de las acciones POST:** por `idempotencyKey`, con el mismo patrón que `performOperatorAction` (`src/server/dispatch/operator-action.ts:23-59`). Lock de dos claves; el resultado se guarda en `events` con `data.idempotency_key`; un reintento con la misma clave devuelve lo mismo, y con otra acción da 409 `idempotency_key_reused`.
- **Textos de UI** en español rioplatense, con las etiquetas de `src/app/operacion/_components/labels.ts`. Ningún dato operativo hardcodeado: tipos y unidades salen de la base.
- **Bases de test propias:** Task 1 `radar_urbano_test_revback`, Task 2 `radar_urbano_test_revdet`, Task 3 `radar_urbano_test_revui`.
  - `createdb <base> && psql -d <base> -c "create extension postgis"`.
  - Correr con `DATABASE_URL=postgres://localhost/<base> DATABASE_URL_TEST=postgres://localhost/<base> DEMO_OPERATOR_PASSWORD=local-op DEMO_UNIT_PASSWORD=local-unit SESSION_SECRET=local-session-secret-0123456789abcdef`.
  - Baseline: 292 tests verdes.
- `git` dentro del worktree: `/usr/bin/git`. Editar con Read/Edit.
- **Flujo de `AGENTS.md`:**
  1. Tests, typecheck y lint.
  2. Loop de revisión interna hasta que no queden hallazgos graves.
  3. Push y check «Tenki Code Review».
  4. Corregir o justificar en el hilo. Un hilo viejo re-anclado a un commit nuevo no es un hallazgo nuevo.
  5. Mergear si queda limpio.

## Acciones por tipo de ítem (decisión del plan)

`actionsFor(kind, entityType)` devuelve exactamente esto. La UI muestra solo estas acciones.

| kind | entidad | acciones |
| --- | --- | --- |
| `uncertain_duplicate` | report | `link` (a uno de los `candidate_incident_ids`), `create_incident`, `dismiss` |
| `insufficient_evidence` | report | `create_incident`, `dismiss` |
| `insufficient_evidence` | incident | `allow_dispatch`, `set_type`, `set_severity`, `dismiss` |
| `contradiction`, `low_confidence`, `unknown_type` | incident | `set_type`, `set_severity`, `allow_dispatch`, `dismiss` |
| `contradiction`, `low_confidence`, `unknown_type` | report | `create_incident`, `dismiss` |
| `no_compatible_unit` | incident | `allow_dispatch`, `set_type`, `dismiss` |
| `rejected_assignment` | incident | `allow_dispatch`, `set_type`, `set_severity`, `dismiss` |
| `incompatible_assignment` | assignment | `allow_dispatch`, `dismiss` |
| `provider_failure` | report / incident | `retry`, `dismiss` |
| `out_of_coverage` | report | `dismiss` |

**`reassign` no se ofrece en el MVP.** Asignar a una unidad elegida necesita un despacho manual que hoy no existe. Una orden rechazada se resuelve con `allow_dispatch`, el planificador vuelve a elegir y puede volver a proponer la misma unidad. Si llega un `reassign`, se rechaza con 400 `action_not_available`. Queda anotado como limitación en el PR y en `HANDOFF.md` (plan C).

## Semántica de cada acción (`resolveReviewItem`)

Todas corren en la transacción del llamador:
- toman `pg_advisory_xact_lock(hashtext(territory_id))` (el lock que usa el pipeline) y bloquean el ítem con `for update`;
- un ítem que no está `open` ⇒ 409 `review_item_closed`; una acción que no está en `actionsFor` ⇒ 400 `action_not_available`;
- al final:
  1. cierran el ítem: `status` `resolved` (o `dismissed` para `dismiss`), `resolution = { action, …params, note }`, `resolved_by = actor.id`, `resolved_at = now()`;
  2. recalculan con `recomputeDispatchBlocked(c, await incidentsAffectedByReviewItem(c, id))`, **después** de cerrar, como dice el contrato;
  3. registran el evento `review_resolved` sobre la entidad;
  4. encolan `plan` del territorio (`dedupeSuffix: review:<id>`).

Qué hace cada acción:
- **`link`:** `incidentId` debe estar en los `candidate_incident_ids` del ítem; si no, 400 `not_a_candidate`. Llama a `linkReport(c, { reportId, incidentId, origin: "manual", actor })`, que reevalúa por su cuenta.
- **`create_incident`:** `createIncidentFromReport(c, { reportId, actor })`.
- **`set_type` / `set_severity`:** el ítem sobre un incidente usa ese incidente. Lee la `revision` vigente bajo lock y llama a `setOverride(c, { incidentId, override: { field: "problem_type_id" | "severity", value }, reason: note ?? \`revisión: ${kind}\`, actor, expectedRevision })`.
- **`allow_dispatch`:**
  - Sobre un incidente: solo cierra el ítem, el desbloqueo sale del recálculo.
  - Sobre una orden (`incompatible_assignment`): además `update assignments set review_blocked = false, version = version + 1 where id = $1`, con su evento.
- **`retry`:**
  - `provider_failure` sobre un reporte: si el reporte es `draft`, `enqueue('evaluate_report')` para su revisión; si es `confirmed`, `enqueue('process_report')` para `confirmed_revision`, más `update reports set processing = 'pending' where processing = 'error'`. `enqueue` revive el job fallido.
  - Sobre un incidente: `enqueue('assess_incident')` para su revisión vigente.
- **`dismiss`:** solo cierra el ítem.

## Review Focus

1. **Doble clic o reintento de red al resolver.** La misma `idempotencyKey` devuelve el mismo resultado sin aplicar dos veces. Por ejemplo, un `link` doble no puede crear dos vínculos ni dos `create_incident`. Test en Task 1.
2. **Dos operadores resuelven el mismo ítem a la vez.** Uno gana y el otro recibe 409 `review_item_closed`. No se aplican dos acciones. Test en Task 1, con dos transacciones concurrentes.
3. **Un incidente con dos ítems abiertos.** Resolver uno no lo desbloquea mientras quede el otro, y un `uncertain_duplicate` abierto que lo lista como candidato también lo mantiene bloqueado. Test en Task 1.
4. **Operador de otro territorio** pidiendo la cola, un ítem, un detalle o una foto ⇒ 403 en la lista y 404 en los recursos por id, sin revelar si existen. Test en Task 1 (cola y resolve) y en Task 2 (detalle y foto) sobre `demo-b`.
5. **Corrección con la revisión vieja.** El detalle muestra la revisión 3, otro proceso sube a la 4, y el operador corrige ⇒ 409 `revision_conflict`. La UI refresca y avisa sin perder lo que el operador eligió. Test de API en Task 2; la UI lo maneja en su Step 4.

---

### Task 1: Dominio y API de la cola de revisión

**Files:**
- Create: `src/server/pipeline/create-incident.ts`, `src/server/review/actions.ts`, `src/server/review/resolve.ts`, `src/server/review/queue.ts`, `src/app/api/operacion/review/route.ts`, `src/app/api/operacion/review/[id]/resolve/route.ts`
- Modify: `src/server/pipeline/process-report.ts` (la creación del incidente, líneas ~141-175, pasa a llamar a `createIncidentFromReport`; el comportamiento no cambia)
- Test: `tests/db/review.test.ts` (nuevo)

**Interfaces:**
- **`createIncidentFromReport`.** Firma: `createIncidentFromReport(c: Db, input: { reportId: string; evaluation: StoredEvaluation; areaId: string | null; areaName: string | null; groupingDecisionId: string | null; origin: "auto" | "manual" }): Promise<{ incidentId: string }>`.
  - Hace exactamente lo que hoy está dentro de `writeOutcome`: prioridad, título, insert en `incidents`, `insertLink`, `enqueueTextgen` y el `incident_assessments` de la revisión 1 con `evidence_summary.assessed`.
  - `processReport` lo llama con `origin: "auto"`. **La suite existente tiene que seguir verde sin tocar sus aserciones**: es la prueba del refactor.
  - Para `create_incident` desde la cola, `resolve.ts` carga la evaluación vigente del reporte (`report_evaluations` con `report_revision = confirmed_revision`, con el mismo shape que usa `process-report`; reutilizar su lector si existe, si no exportar uno desde `process-report.ts` sin cambiar su lógica), ubica el punto con `locatePoint` y llama con `origin: "manual"`.
  - Después pone `reports.grouping = 'linked'`, registra el evento `incident_created_manually` y deja encolado el `plan`. Si el reporte no tiene evaluación aplicable o está fuera de cobertura ⇒ 400 `report_not_promotable`.
- **`actionsFor`.** Firma: `actionsFor(kind: ReviewKind, entityType: "report" | "incident" | "assignment"): ResolveAction["action"][]`, en `src/server/review/actions.ts`. Implementa la tabla del plan. Es pura y la importa también la UI (Task 3); por eso **no importa nada de `pg`**.
- **`resolveReviewItem`.** Firma: `resolveReviewItem: ResolveReviewItem`, en `src/server/review/resolve.ts`, exactamente la de `src/server/contracts.ts:46`. Una variante `resolveReviewItemIdempotent(c, { reviewItemId, actor, body: ResolveBody }): Promise<{ reviewItemId; status; replayed: boolean }>` envuelve la idempotencia (Global Constraints) y es la que usa la ruta.
- **`listReviewQueue`.** Firma: `listReviewQueue(db: Db, territoryId: string, opts?: { status?: "open" | "all"; limit?: number }): Promise<ReviewItemView[]>`, en `src/server/review/queue.ts`.
  - Solo ítems `open` por defecto, con límite de 200.
  - **Orden:** peligro activo desc, banda (`high`, `medium`, `low`, `unknown`), `created_at` asc, `id`.
  - **Banda, peligro y título:**
    - ítem sobre un incidente: los de ese incidente;
    - ítem sobre una orden: los de su incidente;
    - ítem sobre un reporte: la banda más alta entre sus `candidate_incident_ids`, o `unknown`; el título es `«Reporte <public_code>: <primeros 80 caracteres de la descripción>»`.
  - `actions = actionsFor(kind, entityType)`.
- **Rutas:**
  - `GET /api/operacion/review?territory=<slug>` ⇒ `ReviewQueueResponse`. El territorio se resuelve como en `src/app/api/operacion/incidents/route.ts`.
  - `POST /api/operacion/review/[id]/resolve`, con cuerpo `ResolveBody` ⇒ `{ reviewItemId, status, replayed }`. El territorio del ítem es `review_items.territory_id`.

- [ ] **Step 1: Tests que fallan** en `tests/db/review.test.ts`. Reutilizar `confirmedReport`, `drain`, `fakeJev`, `fakeAnswers`, `fakeComparison`, `territoryId` y `testDeps` de `tests/db/fakes.ts`, y el armado de candidatos de `tests/db/group.test.ts`.
  - **`uncertain_duplicate` + `link`:** dos incidentes candidatos y un reporte con un ítem abierto (los dos candidatos con `dispatch_blocked`). Resolver con `link` al primero:
    - vínculo activo `manual`;
    - `assess_incident` encolado para el elegido;
    - los dos candidatos con `dispatch_blocked = false`;
    - ítem `resolved` con `resolution.action = 'link'`;
    - un job `plan` con sufijo `review:<id>`.
  - **`link` a un incidente que no es candidato** ⇒ `DomainError` 400 `not_a_candidate`, y el ítem sigue `open`.
  - **`create_incident`** sobre un `uncertain_duplicate`:
    - un incidente nuevo con el título, la banda y el `incident_assessments` de revisión 1 que daría `processReport`;
    - un `textgen` encolado;
    - el reporte con `grouping = 'linked'`.
  - **`rejected_assignment` + `allow_dispatch`:** después de un `transitionAssignment(reject)`, el incidente queda con `dispatch_blocked = false` y un `plan` encolado.
  - **Dos ítems abiertos** sobre el mismo incidente (`contradiction` y `rejected_assignment`): resolver uno lo deja `dispatch_blocked = true`; resolver el otro lo pone en `false`.
  - **`set_severity`:**
    - override de severidad vigente, revisión + 1, ítem `resolved`;
    - con `expectedRevision` desactualizada **no aplica**, porque la lee bajo lock;
    - si el incidente está cerrado ⇒ 409 `incident_closed` y el ítem sigue `open`.
  - **`incompatible_assignment` + `allow_dispatch`** ⇒ `assignments.review_blocked = false` y la `version` sube.
  - **`retry`** de `provider_failure` sobre un reporte confirmado con `processing = 'error'` ⇒ el job `process_report` vuelve a `pending` y el reporte a `processing = 'pending'`.
  - **`reassign`** ⇒ 400 `action_not_available`.
  - **Idempotencia:** misma `idempotencyKey` dos veces ⇒ un solo efecto y `replayed: true` la segunda; misma clave con otra acción ⇒ 409 `idempotency_key_reused`.
  - **Concurrencia:** dos `withTx` en `Promise.all` que resuelven el mismo ítem con claves distintas ⇒ uno OK y el otro 409 `review_item_closed`.
  - **`listReviewQueue`:**
    - un fuego `high` antes que una basura `low` más vieja, y la basura antes que un `unknown`;
    - los ítems de `demo-b` no aparecen en Montevideo (usar `seedTerritoryDemoB` como `tests/db/second-territory.test.ts`);
    - `actions` coincide con `actionsFor`.
  - **`actionsFor`:** un test de tabla con todas las filas de la sección «Acciones por tipo de ítem».
- [ ] **Step 2: Correr y ver que fallan.** `pnpm vitest run tests/db/review.test.ts` ⇒ FAIL, módulos inexistentes.
- [ ] **Step 3: Implementar**, en este orden:
  1. el refactor `createIncidentFromReport`; antes de seguir, correr `pnpm test` completo, que tiene que quedar verde sin cambios;
  2. `actions.ts`;
  3. `resolve.ts`;
  4. `queue.ts`;
  5. las rutas.
- [ ] **Step 4: Suite completa en verde.** `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Smoke de API.** Con una base de desarrollo propia y `pnpm dev -p 3121`:
  1. login de operador (`POST /api/auth/login`);
  2. `GET /api/operacion/review?territory=montevideo` ⇒ 200;
  3. crear un `rejected_assignment` con el flujo real o por SQL en la base de desarrollo;
  4. resolverlo por `POST` ⇒ 200, y el incidente queda con `dispatch_blocked = false`.
- [ ] **Step 6: Commit y PR.** Commits separados para el refactor (`refactor(pipeline): createIncidentFromReport`) y para la cola (`feat(review): resolución de ítems y cola de revisión`). PR `Revisión: dominio y API de la cola` contra `epic/revision`. En el cuerpo: la tabla de acciones, la limitación de `reassign` y el aviso a Operación.

---

### Task 2: Detalle del incidente, correcciones y fotos

**Files:**
- Create: `src/shared/contracts/incident-detail.ts`, `src/server/incidents/detail.ts`, `src/server/incidents/operator-photo.ts`
- Create rutas:
  - `src/app/api/operacion/incidents/[id]/route.ts` (GET)
  - `src/app/api/operacion/incidents/[id]/overrides/route.ts` (POST)
  - `src/app/api/operacion/incidents/[id]/overrides/[field]/route.ts` (DELETE)
  - `src/app/api/operacion/incidents/[id]/links/route.ts` (POST)
  - `src/app/api/operacion/photos/[attachmentId]/route.ts` (GET)
- Create páginas: `src/app/operacion/incidentes/[id]/page.tsx` y `src/app/operacion/_components/IncidentDetail.tsx`
- Test: `tests/db/incident-detail.test.ts` (nuevo)

**Interfaces:**
- **Contrato nuevo** en `src/shared/contracts/incident-detail.ts`. Zod más el tipo inferido, igual que el resto de `src/shared/contracts`:

```ts
export const IncidentDetailResponse = z.object({
  incident: IncidentListItem.extend({
    revision: z.number(),
    passage: z.enum(["total", "partial", "none", "undetermined"]),
    accessibility: z.enum(["affected", "not_affected", "undetermined"]),
    summary: z.string().nullable(),            // incidents.summary (textgen, plan D)
    explainPriority: z.string().nullable(),    // latestTexts(...).explain_priority
    priorityRules: z.array(z.string()),        // priority_breakdown.rules (+ "promoted_by_age" si aplica)
    bandOverride: z.enum(["high", "medium", "low"]).nullable(),
  }),
  overrides: z.array(z.object({ field: z.enum(OVERRIDE_FIELDS), value: z.unknown(), reason: z.string(), createdAt: z.string() })),
  reports: z.array(z.object({
    id: z.string(), publicCode: z.string().nullable(), confirmedAt: z.string().nullable(), linkOrigin: z.enum(["auto", "manual"]),
    description: z.string().nullable(),
    messages: z.array(z.object({ role: z.enum(["citizen", "assistant", "system"]), body: z.string(), createdAt: z.string() })),
    photoIds: z.array(z.string()),             // attachments purpose 'original' del reporte; se sirven por /api/operacion/photos/[id]
  })),
  activeAssignment: z.object({ id: z.string(), status: z.enum(ASSIGNMENT_STATUSES), version: z.number(), unitName: z.string(), reviewBlocked: z.boolean(), offeredAt: z.string() }).nullable(),
  openReviewItems: z.array(z.object({ id: z.string(), kind: z.enum(REVIEW_KINDS), reasons: z.array(z.record(z.string(), z.unknown())), createdAt: z.string() })),
  events: z.array(z.object({ kind: z.string(), actorType: z.string(), createdAt: z.string(), data: z.record(z.string(), z.unknown()) })), // últimos 50, del más nuevo al más viejo
  problemTypes: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })), // habilitados en el territorio, para corregir el tipo
  generatedAt: z.string(),
});
```

  Verificar los valores reales de `messages.role` en `migrations/0002_intake.sql` y ajustar el enum a la migración, que es la que manda.
- **`getIncidentDetail`.** Firma: `getIncidentDetail(db: Db, incidentId: string): Promise<{ territoryId: string; body: IncidentDetailResponse }>`, en `src/server/incidents/detail.ts`.
  - Para los campos de la lista, reutilizar la consulta de `listIncidents` (`src/server/incidents/queries.ts`); si hace falta, extraer su `select` a una función compartida dentro del mismo archivo, sin cambiar lo que devuelve.
  - Id que no es uuid o inexistente ⇒ `notFound`.
  - Los eventos son los del incidente, los de sus reportes vinculados y los de sus órdenes.
- **`getOperatorPhoto`.** Firma: `getOperatorPhoto(db, storage, { territoryId: string; attachmentId: string; size }): Promise<Buffer>`, en `src/server/incidents/operator-photo.ts`. Sirve el derivado JPEG, igual que `src/server/unit/photos.ts`, si el adjunto pertenece a un reporte del territorio del operador; si no, 404.
- **Rutas.** Todas siguen las Global Constraints (sesión primero; `requireOperator` con el territorio del incidente; 404 para lo que no es uuid).
  - `POST …/overrides`, con cuerpo `SetOverrideBody`, llama a `setOverride` ⇒ `{ incidentId, revision }`.
  - `DELETE …/overrides/[field]`: `field` validado contra `OVERRIDE_FIELDS`; llama a `removeOverride`.
  - `POST …/links`, con cuerpo `LinkBody`, llama a `linkReport` o `unlinkReport` (`origin: "manual"`).
  - Las tres son idempotentes por `idempotencyKey`, con el patrón de Global Constraints. Los eventos usan `entity_type: "incident"` y `kind: "operator_request"`.
- **Página `/operacion/incidentes/[id]?territory=<slug>`.** Cliente, con el layout de la consola (`OpsShell`/`OpsHeader`) y el estilo de `IncidentBoard.tsx`. Muestra:
  - **Cabecera:** tipo, banda con motivo (`explainPriority` o, si no hay, las reglas con `labels.ts`), estado, peligro activo, dirección y barrio.
  - **Resumen** (`summary`).
  - **Orden activa** (unidad, estado) con los botones Cancelar y Completar, que usan la ruta existente `POST /api/operacion/assignments/[id]`.
  - **Ítems de revisión abiertos**, con un enlace a `/operacion/revision?territory=…` (la página de la Task 3).
  - **Reportes:** descripción, mensajes del ciudadano y miniaturas (`?size=thumb`), con «Desasociar» y su motivo obligatorio.
  - **Historial de eventos.**
  - **«Corregir datos»:**
    - tipo (`select` de `problemTypes`), severidad y banda, con motivo obligatorio y `expectedRevision = incident.revision`;
    - «Quitar corrección» por cada override vigente;
    - «Marcar resuelto», que es `setOverride` de `status = resolved` y cierra la orden activa en la misma transacción, como ya hace `closeByOperator`.
  - **Errores:** un 409 `revision_conflict` recarga el detalle y muestra «El incidente cambió mientras lo corregías. Revisá y volvé a intentar.» sin borrar la selección. Cualquier otro error muestra el `message` del `DomainError`.

- [ ] **Step 1: Tests que fallan** en `tests/db/incident-detail.test.ts`:
  - **Detalle completo** de un incidente con dos reportes (uno `auto` y uno `manual`), una corrección de severidad vigente, una orden `offered` y un ítem `contradiction` abierto ⇒ `IncidentDetailResponse.parse(body)` no lanza, y `overrides`, `reports` (con `photoIds`), `activeAssignment`, `openReviewItems` y `events` tienen lo esperado.
  - **Fotos:** `getOperatorPhoto` con un adjunto de Montevideo pedido con `territoryId` de `demo-b` ⇒ `notFound`; con el territorio correcto ⇒ devuelve bytes (usar `memoryStorage` de `fakes.ts`).
  - **Id inválido:** `getIncidentDetail` con un id que no es uuid ⇒ `notFound`.
  - **Revisión vieja:** la ruta de overrides con `expectedRevision` vieja ⇒ 409 `revision_conflict`. Si probar la ruta HTTP directo es difícil, probar la función que usa la ruta.
  - **Idempotencia:** la misma `idempotencyKey` en overrides dos veces ⇒ una sola corrección y una sola subida de revisión.
- [ ] **Step 2: Correr y ver que fallan.**
- [ ] **Step 3: Implementar** contrato, dominio y rutas.
- [ ] **Step 4: Implementar la página.** Antes, leer la guía de App Router en `node_modules/next/dist/docs/` (rutas dinámicas y `params` como `Promise`).
- [ ] **Step 5: Suite completa en verde, más un smoke.**
  - `pnpm test && pnpm typecheck && pnpm lint`.
  - Smoke con base propia, `pnpm dev -p 3122` y un incidente creado por `scripts/e2e-walkthrough.mjs http://localhost:3122`:
    - `GET /api/operacion/incidents/<id>` ⇒ 200 y valida con el contrato;
    - `/operacion/incidentes/<id>?territory=montevideo` ⇒ 200;
    - una corrección de severidad por `POST` ⇒ revisión + 1;
    - la foto ⇒ 200 `image/jpeg`.
- [ ] **Step 6: Commit y PR** `Revisión: detalle del incidente, correcciones y fotos para el operador` contra `epic/revision`. En el cuerpo, avisar a Operación del contrato nuevo `incident-detail.ts`.

---

### Task 3: Página de la cola y navegación

**Files:**
- Create: `src/app/operacion/revision/page.tsx`, `src/app/operacion/_components/ReviewQueue.tsx`
- Modify: `src/app/operacion/_components/OpsShell.tsx` (ítem «Revisión»), `src/app/operacion/_components/IncidentBoard.tsx` (cada incidente enlaza a su detalle), `src/app/operacion/_components/labels.ts` (etiquetas de `REVIEW_KINDS` y de las acciones)

**Interfaces:**
- Consume `GET /api/operacion/review?territory=<slug>` ⇒ `ReviewQueueResponse`, que ya está en el contrato, y `POST /api/operacion/review/[id]/resolve` con `ResolveBody` (los dos de la Task 1).
- Importa `actionsFor` de `src/server/review/actions.ts` (Task 1) **solo si ya está mergeado**. Si no, usa `item.actions`, que viene en la respuesta y alcanza.
- Enlaza al detalle `/operacion/incidentes/<id>?territory=<slug>` (Task 2) desde los ítems sobre un incidente y desde los candidatos de un `uncertain_duplicate`.
- **Navegación:** `OpsSidebar` suma `{ href: "/operacion/revision" + q, label: "Cola de revisión", short: "Revisión", icon: <uno existente de Icons.tsx>, match: p => p.startsWith("/operacion/revision") }`. Si `summary.review > 0`, la lista ya lo tiene en el encabezado; agregar el contador al ítem de navegación es opcional.
- **`labels.ts`** suma:
  - `REVIEW_KIND`, con una etiqueta por cada `REVIEW_KINDS`. Por ejemplo: `uncertain_duplicate: "Posible duplicado"`, `insufficient_evidence: "Evidencia insuficiente"`, `contradiction: "Reportes que se contradicen"`, `low_confidence: "Clasificación dudosa"`, `unknown_type: "Tipo desconocido"`, `no_compatible_unit: "Sin unidad compatible"`, `rejected_assignment: "Orden rechazada"`, `incompatible_assignment: "Orden incompatible"`, `provider_failure: "Falla del análisis"`, `out_of_coverage: "Fuera de cobertura"`.
  - `REVIEW_ACTION`, con una por cada acción: `link: "Asociar a este incidente"`, `create_incident: "Crear incidente nuevo"`, `set_type: "Corregir tipo"`, `set_severity: "Corregir severidad"`, `allow_dispatch: "Permitir despacho"`, `retry: "Reintentar análisis"`, `dismiss: "Descartar"`.
  - Las dos con el tipo `Record<…>` exhaustivo, para que `tsc` falle si falta una.

**Comportamiento de la página `/operacion/revision?territory=<slug>`:**
- Cola ordenada como viene de la API, con polling cada 15 s (mismo patrón que `IncidentBoard`; no superponer cargas).
- Cada tarjeta muestra:
  - tipo de ítem y motivo legible: `reasons[].code` traducido cuando hay etiqueta, y si no, el código;
  - título, banda y peligro activo;
  - antigüedad («hace 12 min»);
  - enlace al detalle cuando la entidad es un incidente.
- **`uncertain_duplicate`:**
  - lista los `candidate_incident_ids` de `evidenceRefs`, cada uno con enlace al detalle y un botón «Asociar a este incidente», que manda `{ action: "link", incidentId }`;
  - además, «Crear incidente nuevo» y «Descartar».
- **`set_type`:** un `select` de tipos. Los tipos salen de `GET /api/operacion/incidents?territory=…` (`filters.problemTypes`), pero esa respuesta trae `slug` y no `id`. Tomar el `id` de `GET /api/operacion/incidents/[id]` (`problemTypes`, Task 2). Si la Task 2 todavía no está mergeada, ofrecer `set_type` solo desde el detalle y dejar en la cola solo `set_severity`.
- **`set_severity`:** tres botones (Baja, Media, Alta).
- **Nota y confirmación:**
  - nota opcional en todas las acciones;
  - obligatoria para `dismiss` y para las correcciones;
  - confirmación antes de `dismiss` y de `create_incident`.
- **Clave de idempotencia:** una por intento de acción con `crypto.randomUUID()`. Se reutiliza si el usuario reintenta la misma acción después de un error de red.
- **Después de resolver:** sacar la tarjeta con un mensaje breve («Resuelto: Asociado al incidente …»). Un 409 `review_item_closed` muestra «Otro operador ya lo resolvió» y refresca.
- **Accesibilidad:** botones con texto, foco visible y `aria-live` para los mensajes, igual que la consola.

- [ ] **Step 1: Implementar** `labels.ts`, `ReviewQueue.tsx`, la página y la navegación. Leer antes la guía de App Router en `node_modules/next/dist/docs/` y los componentes `IncidentBoard.tsx` y `PlanBoard.tsx`, para copiar el polling, los estados de carga y de error, y el layout.
- [ ] **Step 2: `pnpm typecheck && pnpm lint && pnpm test`** (la suite no debería cambiar).
- [ ] **Step 3: Enlaces de la lista al detalle.** En `IncidentBoard.tsx`, el título de cada incidente pasa a ser un `Link` a `/operacion/incidentes/<id>?territory=<slug>`.
- [ ] **Step 4: Abrir el PR temprano.** Commit y PR `Revisión: cola de revisión y navegación de la consola` contra `epic/revision`, marcado con «depende de la Task 1» en el cuerpo.
- [ ] **Step 5: Esperar a que la Task 1 esté mergeada en `epic/revision`.** Revisar cada 2 min con `gh pr list --base epic/revision --state merged --json headRefName`, hasta 90 min. Después: `/usr/bin/git merge origin/epic/revision`, resolver conflictos y suite completa.
- [ ] **Step 6: Smoke real y merge.**
  - Smoke con base propia y `pnpm dev -p 3123`, después del merge de la Task 1:
    1. crear un `rejected_assignment` (flujo real o SQL en la base de desarrollo);
    2. `/operacion/revision?territory=montevideo` ⇒ 200;
    3. `GET /api/operacion/review` ⇒ el ítem aparece;
    4. resolverlo con la API como lo haría la página ⇒ desaparece de la cola.
  - Recién ahí, flujo de Tenki y merge. Si a los 90 min la Task 1 no está mergeada, reportarlo y no mergear.

---

### Task 4: Corte a `main` (quien coordina)

- [ ] Con las Tasks 1, 2 y 3 en `epic/revision`:
  1. `/usr/bin/git merge-base --is-ancestor origin/main origin/epic/revision`. Si `main` avanzó, traerlo y correr la suite.
  2. Suite completa sobre la cabeza.
  3. Smoke en local del guion: rechazo de orden ⇒ ítem en la cola ⇒ «Permitir despacho» ⇒ orden nueva; y corregir severidad desde el detalle ⇒ banda nueva y plan.
  4. PR `epic/revision → main`, Tenki y merge. **Despliega.**
  5. Sin seeds ni migraciones nuevas: no hace falta correr nada contra Supabase.
- [ ] Avisar a Operación, con un comentario en el PR, de los archivos nuevos en su módulo y de la limitación de `reassign`.
