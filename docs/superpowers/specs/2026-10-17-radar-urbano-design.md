# Radar Urbano — documento de diseño

Fecha: 17 de octubre de 2026. Estado: diseño acordado, implementación pendiente.

Este documento fija las decisiones de sistema y de datos para implementar el MVP. Complementa y, donde difiere, **prevalece sobre** [ALCANCE-RADAR-URBANO.md](../../../ALCANCE-RADAR-URBANO.md), [ARQUITECTURA-RADAR-URBANO.md](../../../ARQUITECTURA-RADAR-URBANO.md) e [INTEGRACION-JEV.md](../../../INTEGRACION-JEV.md). Esos documentos siguen siendo la referencia para el catálogo, las reglas de prioridad y planificación, los criterios de terminado y el roadmap; no se repiten acá.

Versiones visuales compartibles: [diseño de sistema](https://claude.ai/artifact/885kaef8rpfGRJKxi6j6f2) y [modelo de datos](https://claude.ai/artifact/NnxVxLomvXAvCw55dnH1uX).

## 1. Intención

Hoy no existe un sistema: los avisos ciudadanos se gestionan a mano y por eso el proceso es lento e inconsistente. Radar Urbano **crea** ese proceso, no acelera uno existente. El sistema es la fuente de verdad desde el primer día y corre solo de punta a punta: mensaje → evaluación → agrupación → prioridad → plan → orden en la bandeja de la unidad. El humano no aprueba pasos; entra únicamente por una **cola de revisión** y por **correcciones** que el sistema conserva.

Montevideo es el piloto porque tenemos su GeoJSON de barrios. Nada de la lógica depende de la ciudad: territorios, áreas, catálogo, unidades, políticas y plantillas son filas en la base.

## 2. Objetivos, no objetivos, antiobjetivos

**Objetivos del MVP**

- Un ciudadano reporta desde el celular sin cuenta, conversando; el sistema pide lo que falta y confirma ubicación y envío con controles explícitos.
- Cada mensaje se evalúa con Jev; los reportes del mismo problema se agrupan automáticamente; el incidente se reevalúa con la evidencia acumulada.
- Un planificador determinista ordena la cola por riesgo, espera y corroboración acotada, y propone unidades preservando recursos escasos.
- El despacho crea órdenes transaccionales que la unidad acepta desde su bandeja web.
- El operador ve la cola de revisión, el plan y el mapa; corrige por campo y sus correcciones sobreviven a las reevaluaciones.

**No objetivos** (roadmap, no se implementan): WhatsApp/SMS, QR contextual, reputación de fuentes, audio, integraciones institucionales, rutas óptimas, cierre automático por foto, administración de usuarios o de configuración por pantalla.

**Antiobjetivos** (el producto falla aunque “funcione”):

- Datos operativos hardcodeados en código o prompts.
- Un botón manual disfrazado de agrupación automática.
- Una reevaluación que pisa una corrección humana.
- Volumen de reportes que infla severidad o supera un peligro activo.
- Una integración de IA simulada sin declararlo.
- Dos órdenes activas para un incidente o una unidad por encima de su capacidad.

## 3. Restricciones

- TypeScript, Node.js ≥ 22, Next.js 16, Zod, `pg` con migraciones SQL propias, PostgreSQL 16+ con **PostGIS**. Un repositorio: app web y worker como dos procesos que comparten los módulos de dominio.
- Jev vía `@typesafe-ai/sdk` 0.7.x (`TypeSafeClient.systemOne`, Choice y Noul). Modelo configurado en política; propuesta inicial `jev-1.14.0`. Imágenes con header `TypeSafe-Danger-Zone-Images: true`, JPEG/PNG, 280–1568 px por lado, orientación aplicada antes de enviar.
- LLM: **modelo open source servido por el equipo en Tenki** detrás de una API compatible con OpenAI (vLLM o equivalente). Se accede con el SDK `openai` apuntando a `LLM_BASE_URL`, con `LLM_API_KEY` y `LLM_MODEL` por entorno. Salidas estructuradas vía `response_format: { type: 'json_schema' }` (guided decoding del servidor) con validación Zod del lado nuestro y plantilla de respaldo si el JSON no valida. No se usa cuenta de OpenAI.
- Geocodificación detrás de una interfaz; Nominatim por defecto con caché persistida y `User-Agent` propio. Mapa base OSM con Leaflet.
- Credenciales solo por entorno (`TYPESAFE_API_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `DATABASE_URL`). Nunca en seeds, documentos ni logs.
- Despliegue recomendado Railway (web + worker) y Supabase (PostgreSQL con PostGIS, Storage privado). No provisionado; el desarrollo usa Postgres local y disco local detrás de la misma interfaz de storage.
- Accesibilidad mínima del alcance: controles de 44 px, texto base 16 px, contraste AA, foco visible, prioridad legible sin color.

## 4. Decisiones tomadas en esta sesión

| Decisión | Resolución | Motivo |
| --- | --- | --- |
| Rol del humano | Solo revisión y corrección; el camino feliz corre sin aprobación. | No hay proceso previo que preservar; el valor es la automatización. |
| Primer evaluador del mensaje | **Jev en la recepción**, en cada mensaje, antes de cualquier otra cosa. | Es el proveedor más rápido y barato por mensaje; el volumen de mensajes es la variable que crece. |
| Rol del LLM con el ciudadano | **Solo cuando Jev lo pide**: extraer dirección, redactar repregunta ante ambigüedad o evidencia insuficiente, interpretar correcciones. Todo lo demás son plantillas y botones. | Mantiene costo bajo sin que el chat sea un formulario. El LLM nunca decide tipo, severidad ni confirma nada. |
| Cola de revisión | Tabla propia `review_items` con tipo, entidad, evidencia, estado y resolución. | El operador vive ahí; necesita historial de quién decidió qué. |
| Geografía | **PostGIS** desde el inicio. | Búsquedas de candidatos, barrio y distancias en SQL con índices; disponible local y en Supabase. |
| Conversaciones | **Una conversación por reporte.** La sesión ciudadana tiene varias. | Una persona reporta varias cosas; cada una merece su hilo. |
| Agrupación | Si Jev no gatea la respuesta sincrónica a tiempo, el mensaje queda “recibido, analizando” y la misma evaluación termina como job. | Nunca se pierde un mensaje por latencia del proveedor. |

## 5. Diseño de sistema

### 5.1 Capas

- **Superficies**: `/reportar` (ciudadano), `/operacion` (operador), `/unidad` (bandeja de unidad).
- **Web (Next.js)**: API con contratos Zod compartidos; mutaciones solo a través de servicios de dominio con clave de idempotencia y versión esperada; orquestador de recepción; acceso (sesión ciudadana opaca por cookie, cuentas internas seed con `iron-session`).
- **Fuente de verdad**: PostgreSQL + PostGIS; storage privado de fotos detrás de `StorageAdapter` (disco local / Supabase Storage).
- **Worker**: proceso Node del mismo repo que toma jobs con lease y ejecuta el pipeline.
- **Externos**: Jev, OpenAI, geocodificador.

### 5.2 Recepción con Jev primero

1. **Persistir**: el mensaje (texto, `client_message_id`), la foto original y su derivado normalizado se guardan antes de cualquier IA. La revisión del borrador sube.
2. **Evaluar con Jev** en una llamada sobre el estado completo del borrador (todos los mensajes ciudadanos, derivados de fotos, ubicación confirmada si existe, catálogo activo con criterios). Preguntas:
   - Choice `intent`: `report` / `status_query` / `other`. Decide la rama conversacional.
   - Choice `applicability`: `applicable` / `unrelated` / `insufficient`. Decide si la evidencia alcanza para un incidente; es la que gatea despacho (`min_applicability`).
   - Choice `problem_type`: slugs del catálogo activo + `other` + `unknown`.
   - Choice `severity`: `low` / `medium` / `high` / `undetermined`.
   - Choice `active_fire`: `yes` / `no` / `undeterminable`.
   - Choice `passage`: `total` / `partial` / `none` / `undetermined`.
   - Choice `accessibility`: `affected` / `not_affected` / `undetermined`.
   - Choice `location_in_text`: `precise` / `vague` / `absent`.
   - Choice `photo_quality`: `useful` / `insufficient` / `no_photo`.
   - Choice `text_photo_consistency`: `consistent` / `contradiction` / `not_evaluable`.
   - Noul por hecho puntual que la política defina (p. ej. `photo_shows_fire`, `recurring_problem_claimed`).
   La llamada es sincrónica con timeout configurado por política; si expira, se encola `evaluate_report` y el chat muestra “recibido, analizando”.
3. **Elegir rama por política de `intake`** (umbrales por pregunta, rondas máximas de repregunta, campos obligatorios):
   - `other` → plantilla de orientación; no se crea nada visible al operador.
   - `status_query` → tarjeta de estado renderizada desde la base para ese reporte.
   - `report` con `location_in_text = absent|vague` y sin ubicación confirmada → plantilla + botones (usar mi ubicación, elegir en el mapa, escribir dirección).
   - `report` con `location_in_text = precise` y sin ubicación confirmada → LLM `extract_address` → geocodificador → pin propuesto → la persona confirma.
   - `report` con `photo_quality = insufficient` o `contradiction` → LLM `clarify` redacta una repregunta concreta; máximo N rondas por política, después continúa y queda marcado para revisión.
   - Mensaje que Jev marca como corrección o ambiguo → LLM `interpret_correction` propone cambio al borrador; el backend valida y la persona confirma.
   - Todo presente → ficha (tipo, severidad, lugar, resumen de plantilla) y botón “Enviar reporte”.
4. **Confirmar**: transacción que pasa el reporte a `confirmed`, fija su revisión y crea el job `process_report` único para esa revisión. Devuelve `public_code`.

Reglas: Jev no produce texto; el LLM no decide tipo ni severidad ni confirma; la identidad y los permisos nunca vienen de un modelo; el texto ciudadano es evidencia, no instrucción.

### 5.3 Pipeline del worker

Etapas por job, serializadas por territorio con advisory lock:

1. `evaluate_report`: reutiliza `report_evaluations` de la recepción si coinciden `report_revision`, `catalog_hash` y `policy_version_id`; si no, reevalúa. Guarda `ai_runs`.
2. `locate`: `territory` por cobertura (`ST_Contains` sobre `territories.coverage` o unión de `areas.geom`), `area` por `ST_Contains`. Sin cobertura → `outcome = out_of_coverage`, fin.
3. `group`: candidatos = incidentes abiertos del territorio con `ST_DWithin(location, punto, radio_política)`, sin excluir por inactividad; límite de candidatos por política. Por candidato, Jev Choice `same_incident` / `different_incident` / `uncertain` más Noul de contradicciones de objeto, lugar y tiempo. Exactamente un `same` que supera umbral y el resto `different` con evidencia suficiente → asociar. Ninguno → crear incidente. Otro caso → `review_items(kind = uncertain_duplicate)`. Si el límite truncó candidatos relevantes → revisión.
4. `assess_incident`: Jev reevalúa tipo, severidad, peligro activo y evolución con observaciones originales, hechos evaluados, fechas y conteos del backend. Aplica overrides vigentes al calcular el valor efectivo. Sube `incidents.revision`.
5. `prioritize`: política `priority` → banda por riesgo (fuego activo, bloqueo total, accesibilidad confirmada, severidad), promociones por antigüedad, desglose persistido en `priority_breakdown`.
6. `plan`: `buildPlan(snapshot, policy, now)` pura y determinista; `plan_runs` + `plan_items` con razones y desglose (horas de espera, fuentes distintas en ventana, bonus = `min(tope, peso × log2(max(1, fuentes)))`, costo de oportunidad).
7. `dispatch`: por cada propuesta elegible, en una transacción: `SELECT … FOR UPDATE` de incidente y unidad, revalidar revisión, capacidad libre, capacidades requeridas (`problem_type_requirements`, incluida `active_hazard`), vigencia de posición y radio; insertar `assignments` y `events`. Índice único parcial impide dos órdenes activas por incidente.
8. `generate_text`: títulos, resúmenes, explicaciones del plan y de prioridad desde hechos y códigos de motivo. Cacheado en `generated_texts` por revisión; con fallback a `message_templates`. Nunca bloquea otra etapa.

Toda excepción crea un `review_items` con `kind` tipado y la entidad queda persistida. Un `review_items` abierto sobre un incidente pone `incidents.dispatch_blocked = true`.

### 5.4 Lazo humano

Toda acción del operador o la unidad se guarda como `events` y encola solo las etapas afectadas:

- Override de tipo / severidad / ubicación → `incident_overrides` → `assess_incident` conserva el valor humano → `prioritize` → `plan`. Si hay orden activa y cambia tipo, ubicación o capacidad requerida → `assignments.review_blocked = true` + `review_items(kind = incompatible_assignment)`.
- Asociar / desasociar → vínculo anterior inactivo con motivo → reevaluar ambos incidentes → `plan`. Incidente sin reportes → `archived` y orden activa cancelada en la misma transacción.
- Rechazo de orden → libera capacidad → incidente `open` + `review_items(kind = rejected_assignment)`; no se reenvía solo.
- Resolver manualmente → cierra o cancela la orden activa en la misma transacción → `plan`.
- Resolver un `review_items` → aplica la acción elegida y reencola.

### 5.5 Contratos de IA (funciones de dominio)

- `evaluateReport(input) → ReportEvaluation | TypedError`
- `compareCandidates(input) → GroupingDecision | TypedError`
- `assessIncident(input) → IncidentAssessment | TypedError`
- `extractAddress(input) → { address, sourceMessageIds } | TypedError` (LLM)
- `clarify(input) → { question, requestedField } | TypedError` (LLM)
- `interpretCorrection(input) → { proposedFields, sourceMessageIds } | TypedError` (LLM)
- `generateText(input) → { body, references } | TypedError` (LLM)

Todas validan que IDs de tipo, candidatos y referencias pertenezcan al input permitido. Se guarda el vector completo de probabilidades y confianza. La política verifica respuesta favorable **y** umbral; nunca confianza sola. Noul no se compara contra umbrales de `confidence`.

**Semántica de umbrales (decisión del diseño):** todo umbral de política (`min_applicability`, `min_type_confidence`, `same_threshold`, `different_threshold`) se compara contra `probabilities[choice]`, la probabilidad de la opción ganadora, no contra `confidence`. `confidence` se persiste y puede usarse como piso adicional opcional (`min_confidence`, por defecto desactivado) porque con muchas opciones de tipo su escala no es comparable entre preguntas. Para Noul, el umbral se compara contra `noul` directamente, con una banda de incertidumbre configurable alrededor de 0,5.

**Si la prueba real de Jev no alcanza la calidad esperada (decisión del diseño):** no se reemplaza Jev por el LLM como decisor. Se suben los umbrales por política para que más casos vayan a `review_items`, se declara la limitación en la demo y se registran los casos para calibrar. El adaptador de Jev se construye contra la API real desde el inicio; no se usan respuestas simuladas salvo en tests unitarios claramente marcados.

## 6. Modelo de datos

PostgreSQL + PostGIS. Estructura, estados y restricciones en SQL; parámetros, criterios y plantillas en filas versionadas. Puntos como `geography(Point, 4326)`, polígonos como `geometry(MultiPolygon, 4326)`, índices GIST en toda columna espacial. Toda tabla tiene `id uuid` (`gen_random_uuid()`), `created_at timestamptz`; las mutables también `updated_at`.

### 6.1 Configuración (seeds)

- `territories`: `slug unique`, `name`, `area_label`, `center geography`, `default_zoom`, `coverage geometry?`, `emergency_channel jsonb`, `enabled`.
- `areas`: `territory_id`, `external_id`, `name`, `geom geometry`, `source_url`, `source_date`, `checksum`. `unique(territory_id, external_id)`.
- `problem_types`: `slug unique`, `name`, `description`, `evaluation_criteria jsonb`, `active`, `sort_order`. `catalog_hash` se calcula sobre las filas activas.
- `territory_problem_types`: `territory_id`, `problem_type_id`, `enabled`, `transient_window_hours?`. PK compuesta.
- `capabilities`: `slug unique`, `name`.
- `problem_type_requirements`: `problem_type_id`, `capability_id`, `condition in (always, active_hazard)`.
- `policy_versions`: `territory_id`, `kind in (intake, evaluation, grouping, priority, planning, dispatch, textgen)`, `version int`, `config jsonb`, `active`. `unique(territory_id, kind, version)`; índice único parcial de una activa por `(territory_id, kind)`.
- `message_templates`: `territory_id?`, `key`, `locale`, `body`, `variables jsonb`. `unique(coalesce(territory_id), key, locale)`.

### 6.2 Recepción

- `citizen_sessions`: `token_hash unique`, `channel`, `external_identity?`, `last_seen_at`.
- `reports`: `citizen_session_id`, `territory_id?`, `area_id?`, `public_code unique`, `status in (draft, confirmed)`, `revision int`, `description`, `location_text`, `location geography?`, `location_source in (gps, map, geocoded)?`, `location_confirmed bool`, `processing in (pending, running, done, error)`, `outcome in (applicable, unrelated, insufficient, out_of_coverage)?`, `grouping in (pending, linked, review)`, `confirmed_at`, `confirmed_revision`. Índice GIST en `location`.
- `conversations`: `report_id unique`, `citizen_session_id`, `revision`, `clarification_rounds int`. Una conversación por reporte.
- `messages`: `conversation_id`, `seq`, `role in (citizen, assistant, system)`, `body`, `origin in (human, template, llm)`, `client_message_id?`, `llm_run_id?`. `unique(conversation_id, client_message_id)`; `unique(conversation_id, seq)`.
- `attachments`: `report_id`, `message_id?`, `storage_key`, `content_type`, `bytes`, `sha256`, `width`, `height`, `derived_from_id?`, `purpose in (original, jev)`.
- `geocode_cache`: `provider`, `query_norm`, `result jsonb`. `unique(provider, query_norm)`.

### 6.3 IA y textos

- `ai_runs`: `purpose in (evaluate, compare, assess)`, `provider`, `model_requested`, `model_returned`, `input_refs jsonb`, `request jsonb` (sin bytes), `response jsonb`, `usage jsonb`, `latency_ms`, `status`, `error`.
- `report_evaluations`: `report_id`, `report_revision`, `ai_run_id`, `policy_version_id`, `catalog_hash`, `intent`, `applicability` (Choice propia, no derivada), `problem_type_id?`, `severity`, `active_fire`, `passage`, `accessibility`, `location_in_text`, `photo_quality`, `contradiction`, `answers jsonb`, `needs_review`, `review_reasons text[]`. `unique(report_id, report_revision)`.
- `grouping_decisions`: `report_id`, `ai_run_id?`, `candidates jsonb`, `outcome in (same, different, uncertain, no_candidates)`, `chosen_incident_id?`, `policy_version_id`, `origin in (auto, manual)`, `actor_id?`.
- `incident_assessments`: `incident_id`, `incident_revision`, `ai_run_id`, `reports_considered uuid[]`, `problem_type_id`, `severity`, `active_hazard`, `evidence_summary jsonb`, `changes jsonb`, `source_counts jsonb`. `unique(incident_id, incident_revision)`.
- `llm_runs`: `purpose in (extract_address, clarify, interpret_correction, title, summary, explain)`, `model`, `instructions_version`, `entity_ref jsonb`, `input_tokens`, `output_tokens`, `latency_ms`, `status`, `error`.
- `generated_texts`: `purpose`, `entity_type`, `entity_id`, `entity_revision`, `body`, `references jsonb`, `llm_run_id?`. `unique(purpose, entity_type, entity_id, entity_revision)`.

### 6.4 Incidentes

- `incidents`: `territory_id`, `area_id?`, `revision int`, `problem_type_id`, `severity`, `active_hazard`, `location geography`, `location_text`, `title`, `summary`, `priority_band in (high, medium, low, unknown)`, `priority_breakdown jsonb`, `status in (open, assigned, in_progress, resolved, archived)`, `dispatch_blocked`, `resolved_at`, `archived_at`. Índice GIST en `location`. Tipo y severidad son el valor efectivo (override si existe, si no la última evaluación).
- `report_incident_links`: `report_id`, `incident_id`, `active`, `origin in (auto, manual)`, `grouping_decision_id?`, `deactivated_at`, `deactivation_reason`. Índice único parcial `(report_id) where active`.
- `incident_overrides`: `incident_id`, `field in (problem_type_id, severity, priority_band, location, status)`, `value jsonb`, `reason`, `created_by`, `removed_at?`, `removed_by?`.

### 6.5 Atención

- `response_units`: `territory_id`, `slug`, `name`, `unit_kind`, `status in (enabled, out_of_service)`, `capacity int`, `location geography?`, `location_updated_at?`, `service_radius_m?`, `is_demo`, `delivery_target`. `unique(territory_id, slug)`.
- `unit_capabilities`: `unit_id`, `capability_id`. PK compuesta.
- `area_responsibilities`: `area_id`, `problem_type_id`, `unit_id`, `precedence int`.
- `plan_runs`: `territory_id`, `policy_version_id`, `computed_at`, `trigger`, `snapshot_refs jsonb`, `stats jsonb`.
- `plan_items`: `plan_run_id`, `incident_id`, `position`, `proposed_unit_id?`, `score_breakdown jsonb`, `reasons jsonb`, `status in (proposed, executed, obsolete, blocked)`, `blocked_reason?`.
- `assignments`: `incident_id`, `unit_id`, `plan_item_id?`, `status in (offered, accepted, in_progress, completed, rejected, cancelled)`, `distance_m?`, `reasons jsonb`, `assessment_id`, `policy_version_id`, `review_blocked`, `offered_at`, `accepted_at`, `started_at`, `completed_at`, `closed_reason?`. Índice único parcial `(incident_id) where status in (offered, accepted, in_progress)`. Capacidad de la unidad se verifica bajo lock.

### 6.6 Sistema

- `jobs`: `kind`, `entity_type`, `entity_id`, `entity_revision`, `dedupe_key unique`, `territory_id?`, `status in (pending, running, done, failed)`, `attempts`, `max_attempts`, `run_after`, `lease_until`, `locked_by`, `last_error`, `payload jsonb`. Toma con `FOR UPDATE SKIP LOCKED`; `pg_advisory_xact_lock` por territorio para etapas 3–7.
- `review_items`: `territory_id`, `kind in (insufficient_evidence, uncertain_duplicate, contradiction, low_confidence, unknown_type, no_compatible_unit, rejected_assignment, incompatible_assignment, provider_failure, out_of_coverage)`, `entity_type`, `entity_id`, `reasons jsonb`, `evidence_refs jsonb`, `status in (open, resolved, dismissed)`, `resolution jsonb`, `resolved_by?`, `resolved_at?`. Índice parcial sobre `status = open`.
- `events`: `entity_type`, `entity_id`, `kind`, `actor_type in (system, operator, unit, citizen)`, `actor_id?`, `data jsonb`. Solo inserción.
- `internal_users`: `username unique`, `password_hash`, `role in (operator, unit)`, `territory_id`, `response_unit_id?`.

### 6.7 Invariantes

- Un reporte tiene a lo sumo un vínculo activo con un incidente.
- Un incidente tiene a lo sumo una orden activa.
- Una unidad nunca supera `capacity` en órdenes activas (verificado bajo lock).
- Un borrador solo puede confirmarse una vez; reintentos devuelven el mismo `public_code`.
- Una evaluación guarda la revisión que evaluó; si la revisión cambió, se descarta y reencola.
- Los overrides no se eliminan por reevaluación.
- Seeds insertan lo ausente por clave natural (`slug`, `external_id`, `key`) y no actualizan filas que operación haya tocado; `reset-demo` y `refresh-demo-positions` son comandos aparte.

## 7. Políticas (contenido de `policy_versions.config`, valores iniciales de seed)

- `intake`: `jev_timeout_ms`, `max_clarification_rounds = 2`, `thresholds` por pregunta, `require_photo = false`.
- `evaluation`: `model = jev-1.14.0`, `image_header = true`, `noul_facts` a preguntar.
- `grouping`: `radius_m = 30`, `max_candidates`, `same_threshold = 0.90`, `different_threshold`.
- `priority`: reglas de banda, `promote_low_to_medium_after_hours = 48`.
- `planning`: `window_hours = 24`, `weight_hours = 2`, `cap_hours = 12`, orden lexicográfico y pesos de desempate.
- `dispatch`: `min_applicability = 0.90`, `min_type_confidence = 0.90`, `max_distance_m = 3000`, `position_max_age_min = 30`, `strategy in (nearest_mobile, zone_owner, manual)` por tipo.
- `textgen`: `model` (nombre servido en Tenki), `instructions_version`, `max_output_tokens`, `timeout_ms`, `enabled`.

## 8. Qué queda al criterio del builder

- Estructura de carpetas, nombres de módulos y organización de tests, respetando los límites de módulo de la arquitectura.
- Migrador SQL concreto, formato de seeds (TS o SQL) y CLI de comandos (`migrate`, `seed`, `import-areas`, `seed-demo`, `reset-demo`, `refresh-demo-positions`, `worker`).
- Diseño visual de las tres superficies dentro de los criterios de accesibilidad.
- Forma exacta de los prompts del LLM y de los criterios por opción enviados a Jev, versionados en `policy_versions` y `problem_types.evaluation_criteria`.
- Estrategia de tests: unitarios para `buildPlan`, políticas y máquinas de estado; de integración contra Postgres local para jobs, dispatch y geografía; smoke scripts para Jev y OpenAI con credenciales reales, con fixtures guardados.

## 9. Marco operativo confirmado

- **Tiempo:** unas 12 horas desde el 17 de octubre de 2026 por la tarde. **Equipo:** tres personas en paralelo (A recepción, B datos/IA/pipeline, C operación/planificación), más esta sesión como implementadora principal.
- **Demo:** desde celulares reales por internet para ciudadano y bandeja de unidad; dashboard del operador en Mac. Por lo tanto **se despliega**: Railway (web + worker) y Supabase (PostgreSQL con PostGIS, Storage privado). El despliegue se prepara temprano con la primera sección funcional, no al final, para que las últimas horas sean de contenido y no de infraestructura.
- **Orden de prioridad ante recortes** (se recorta de abajo hacia arriba): 1) reporte con Jev real → incidente visible en dashboard, desplegado; 2) agrupación automática y reevaluación; 3) planificador, despacho y bandeja de unidad; 4) cola de revisión con resolución; 5) LLM en recepción (dirección, repreguntas, correcciones) y textos generados; 6) responsable de zona y prueba de segundo territorio; 7) pulido visual y accesibilidad más allá del mínimo. Lo que no entra se muestra como pendiente en la demo, nunca simulado.
- **Pendiente:** `TYPESAFE_API_KEY` en `.env` local (existe en el llavero de la Mac); endpoint del LLM en Tenki (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`); cuentas de Railway y Supabase (quién las crea y con qué plan). Las fotos y mensajes de ejemplo los reúne y calibra quien tome el módulo de evaluación (Tarea 2), no bloquean el arranque.
