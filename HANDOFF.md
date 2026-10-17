# Handoff — Radar Urbano

Actualizado: 17 de octubre de 2026 (segunda sesión). Workspace: `/Users/fededallo/Desktop/hackaton`, repo `daizuoheng/build_101_27`, rama `main`.

## Estado real (actualizado 17 oct, ~16:00, rama `feat/mvp`)

**Primer recorrido completo funcionando en local con IA real**: chat → borrador → confirmación idempotente → job → evaluación Jev → incidente visible en `/operacion`. Ver `docs/superpowers/notes/recorrido-1.md` (cómo correrlo) y `docs/superpowers/notes/jev-smoke.md` (validación de Jev 18/18, DeepSeek y Nominatim). Hechas las Tareas 1, 2, 3 y 7, y las partes de las 4, 5, 6, 8 y 13 que pide el recorrido. 29 tests (`pnpm test`).

**Bases compartidas** (PR #2): contratos de plan, órdenes, revisión, overrides y vínculos en `src/shared/contracts/`; firmas de servicios entre módulos en `src/server/contracts.ts`; unidades y usuarios de demo (`pnpm cli seed-demo`, `refresh-demo-positions`, `reset-demo --yes`).

Falta: despliegue (esperando cuentas de Supabase y Railway), agrupación (T9, en curso), reevaluación y overrides (T10), planificador (T11), despacho y bandeja de unidad (T12), cola de revisión (T14) y textos generados (T15).

Para arrancar en local: `pnpm install && pnpm cli migrate && pnpm cli seed && pnpm cli seed-demo`, después `pnpm dev` y `pnpm worker`. `.env` lleva las claves de Jev y DeepSeek. `.env.local` lleva `DATABASE_URL`, `SESSION_SECRET` y `DEMO_*_PASSWORD` (ver `.env.example`).

Ojo: el hook de `rtk` reescribe `git` y choca con la protección del worktree; dentro del worktree usar `/usr/bin/git`.

## Estado anterior (primera sesión)

Diseño y plan acordados y commiteados. No se crearon recursos en Supabase ni Railway.

Marco operativo confirmado: unas 12 horas desde la tarde del 17 de octubre, 3 personas más Claude, demo desde celulares reales por internet (ciudadano y bandeja de unidad) y dashboard en Mac. Por eso **se despliega** en Railway (web + worker) y Supabase (PostgreSQL con PostGIS, Storage privado); el equipo provisiona eso más adelante.

## Documentos, en orden

1. `docs/superpowers/specs/2026-10-17-radar-urbano-design.md`: diseño de sistema y de datos. **Prevalece** sobre los documentos anteriores cuando difieren.
2. `docs/superpowers/plans/2026-10-17-radar-urbano-mvp.md`: 15 tareas con archivos, interfaces, tests y commits; reparto por módulos; hitos.
3. `ALCANCE-RADAR-URBANO.md`, `ARQUITECTURA-RADAR-URBANO.md`, `INTEGRACION-JEV.md`: referencia para catálogo, reglas de prioridad y planificación, criterios de terminado y roadmap.

Visuales compartibles: [diseño de sistema](https://claude.ai/artifact/885kaef8rpfGRJKxi6j6f2) y [modelo de datos](https://claude.ai/artifact/NnxVxLomvXAvCw55dnH1uX).

## Decisiones cerradas en la segunda sesión

- Pipeline autónomo; el humano entra solo por la cola de revisión (`review_items`, tabla propia) y por overrides.
- **Jev evalúa cada mensaje en la recepción**, antes que nada; el LLM entra solo cuando Jev lo pide (extraer dirección, repreguntar, interpretar correcciones) y para textos del operador.
- LLM: **API de DeepSeek** (`deepseek-flash`, compatible con OpenAI, solo `json_object`), no OpenAI ni Tenki.
- **PostGIS** desde el inicio. Una conversación por reporte.
- Umbrales contra `probabilities[choice]`, nunca contra `confidence` sola. Si Jev rinde mal, se suben umbrales y va más a revisión; no se reemplaza por el LLM.
- Reparto por módulos: Recepción ciudadana, Núcleo y pipeline (Claude), Operación. Esquema y contratos (Tarea 1) primero y compartidos.
- Sección de privacidad (Ley 18.331) en el diseño: qué cubre el MVP y qué es roadmap.

## Entorno local verificado

- Node 26, pnpm 10.30, PostgreSQL 18 (Homebrew) con extensión PostGIS disponible; base `radar_urbano` creada y vacía.
- `.env` (gitignoreado) con `TYPESAFE_API_KEY` y `LLM_API_KEY`. Faltan `LLM_BASE_URL`, `LLM_MODEL`, `DATABASE_URL` (no secretos; los agrega la Tarea 1).
- Hooks del repo bloquean `cat`/`grep`/`sed`: usar Read/Edit o codedb. Comandos shell con prefijo `rtk`.

## Reparto por módulos (desde 17 oct ~16:00)

**Flujo por épicas.** `main` tiene las bases compartidas: esquema completo, contratos y seeds (PR #1 y #2). Cada módulo tiene su épica creada desde `main`: `epic/recepcion`, `epic/operacion` y `epic/nucleo`. Cada tarea va en una rama `feat/<tarea>` desde su épica, con PR contra esa épica. Las épicas se mergean a `main` por PR al cerrar un hito, idealmente cada 2 horas. Después de cada merge a `main`, las épicas lo traen (`git merge origin/main`) para no desincronizarse.

Cambios de bases compartidas (migraciones, `src/shared/contracts/*`, `src/server/contracts.ts`, seeds comunes) **no van por las épicas**: van en un PR chico directo a `main`, con aviso al equipo, y cada épica lo trae enseguida.

### Módulo Recepción y superficies móviles

Dueño de `src/app/reportar`, `src/app/unidad`, `src/app/api/reportar`, `src/app/api/unidad`, `src/server/intake/branches.ts` y `src/server/ai/llm/{clarify,interpret-correction}.ts`.

1. Probar `/reportar/montevideo` desde un celular real (LAN con `pnpm dev -H 0.0.0.0`): GPS, cámara, fotos HEIC de iPhone y mapa. Corregir lo que aparezca.
2. Tarea 13, lo que falta: `clarify` (repregunta redactada por el LLM en `ask_evidence`) e `interpret_correction`, ambos con fallback a plantilla. Extracción de dirección y geocodificación ya están.
3. Tarea 12, parte UI: bandeja `/unidad` (tarjetas grandes con Aceptar, Rechazar, Iniciar y Completar; polling cada 10 s) y sus rutas API, que llaman a `transitionAssignment` del módulo Operación.

### Módulo Operación

Dueño de `src/app/operacion`, `src/app/api/operacion`, `src/server/planning`, `src/server/dispatch` y `src/server/review` (excepto `openReviewItem`, que ya existe).

1. Tarea 11: `buildPlan` puro con los 8 tests del plan (no depende de nada; arrancar ya) y la vista "Plan de atención".
2. Tarea 12, dominio: `applyPlan` y `transitionAssignment` con los tests de concurrencia y capacidad.
3. Tarea 14: cola de revisión, detalle del incidente (fotos, evidencia, historial) y acciones del operador. Las correcciones usan `setOverride` y `linkReport`/`unlinkReport` del Núcleo.

### Módulo Núcleo y pipeline (Claude)

Dueño de `migrations`, `seeds`, `scripts/cli.ts`, `src/server/{db,config,jobs,ai/jev,pipeline,incidents}` y del despliegue. En este orden:

1. Seeds de unidades de demo y usuarios de unidad (Tarea 15, parte de seeds), para que Operación y Recepción tengan unidades. Primero, porque desbloquea a los otros dos.
2. Despliegue en Railway y Supabase en cuanto lleguen las cuentas.
3. Tarea 9: agrupación automática con Jev, incluidos `linkReport` y `unlinkReport`.
4. Tarea 10: `assess_incident`, `setOverride`/`removeOverride` y prioridad. Los jobs `plan` y `dispatch` llaman a `buildPlan`/`applyPlan` de Operación.
5. Tarea 15: textos generados.

### Reglas de convivencia

- **Esquema:** solo Núcleo agrega migraciones, para evitar choques de numeración. Si necesitás una columna, pedila.
- **Contratos:** HTTP y tipos en `src/shared/contracts/` (`intake`, `incident`, `evaluation`, `plan`, `assignment`, `review`). Firmas de servicios entre módulos en `src/server/contracts.ts`, con la ruta donde vive cada implementación. Se implementan tal cual; cambiarlos es un PR a `main`.
- **Archivos compartidos:** `src/server/jobs/handlers.ts` y `scripts/cli.ts` solo admiten agregar entradas.
- **Datos operativos:** nada hardcodeado. Unidades, umbrales, plantillas y textos de Jev salen de seeds y políticas.
- **IA en tests:** los tests usan los dobles de `tests/db/fakes.ts`; las integraciones reales se prueban con `pnpm cli smoke-jev`.
- **Antes de cada PR:** `pnpm test`, `pnpm typecheck` y `pnpm lint`.

### Puesta en marcha de cada persona

1. `git checkout main && git pull && pnpm install` (con los PR #1 y #2 mergeados), y crear o traer tu épica.
2. Postgres con PostGIS local (o la base de desarrollo de Supabase cuando exista); crear las bases `radar_urbano` y `radar_urbano_test`.
3. Copiar `.env.example` a `.env.local` y completarlo. Las claves de Jev y DeepSeek se pasan por privado, nunca por el repo.
4. `pnpm cli migrate && pnpm cli seed && pnpm cli seed-demo`, después `pnpm dev` y `pnpm worker`.
   Si tu base ya estaba sembrada y cambió una política del seed, publicala como versión nueva (no se edita en el lugar): `pnpm cli policy-upgrade --kind grouping`.
   Antes de probar, verificá que no quede un worker viejo corriendo: el worker no recarga el código solo.
5. `node --env-file=.env.local scripts/e2e-walkthrough.mjs` para verificar el recorrido.

### Varios agentes en paralelo por persona

Un worktree por agente, nunca dos agentes en la misma carpeta:

```bash
git checkout main && git pull
git branch epic/operacion main && git push -u origin epic/operacion   # épica del módulo (una vez)
scripts/agent-worktree.sh plan     epic/operacion 3201   # ../radar-plan     → rama feat/plan
scripts/agent-worktree.sh revision epic/operacion 3202   # ../radar-revision → rama feat/revision
```

El script crea la carpeta hermana `../radar-<nombre>` con su rama (sin upstream, para que un `git push` no caiga en la base) y sus bases `radar_urbano_<nombre>` y `_test`. También comparte `.env` por symlink, instala, migra y seedea. **Las bases separadas son obligatorias**: los tests vacían la base de test, y dos agentes con la misma base se rompen entre sí.

- **Cantidad:** 2–3 agentes por persona como máximo. Más agentes es más tiempo integrando que construyendo.
- **Separación por archivos:** cada agente es dueño de archivos distintos dentro del módulo. Ejemplo para Operación: agente 1 con `src/server/planning` (buildPlan puro y tests); agente 2 con la cola de revisión (`src/server/review`, `src/app/operacion/revision`); el despacho cuando `buildPlan` esté mergeado.
- **Brief de cada agente:** leer `HANDOFF.md`, el plan (su Tarea N con su bloque **Interfaces**) y el diseño §5–7; qué archivos puede tocar; prohibido tocar `migrations/` y `seeds/`; terminar con `pnpm test && pnpm typecheck && pnpm lint` en verde y un commit en su rama.
- **Integración (la hace la persona, no el agente):** PR de la rama del agente a la épica; antes, correr tests y `scripts/e2e-walkthrough.mjs`. Traer `main` a la épica cada vez que entre algo.
- **Limpieza:** `git worktree remove ../radar-<nombre> && dropdb radar_urbano_<nombre> && dropdb radar_urbano_<nombre>_test`.

Hitos (quedan unas 9 h): **20:00** recorrido desplegado y probado desde celular; **22:00** agrupación, reevaluación y plan; **00:00** despacho, bandeja de unidad y cola de revisión; **01:00** congelar y ensayar la demo.

Pendientes del equipo: provisionar Supabase (con PostGIS) y Railway; fotos y mensajes de ejemplo para calibrar (los reúne quien tome la Tarea 2).
