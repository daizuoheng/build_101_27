# Handoff — Radar Urbano

Actualizado: 17 de octubre de 2026 (segunda sesión). Workspace: `/Users/fededallo/Desktop/hackaton`, repo `daizuoheng/build_101_27`, rama `main`.

## Estado real

Diseño y plan **acordados y commiteados**. **No hay código de aplicación todavía**: ni dependencias, ni migraciones, ni tests, ni despliegue. No se ejecutaron llamadas a Jev ni a DeepSeek. No se crearon recursos en Supabase ni Railway.

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

## Próximo trabajo

1. Esperar el ok de los compañeros al plan (pueden comentar en el repo).
2. Tarea 1 en rama `feat/mvp`: scaffold Next.js 16, migrador, seis migraciones del §6 del diseño, contratos Zod, `.env.example`.
3. Tarea 2: adaptador Jev y prueba real con `smoke-jev`; registrar modelo devuelto, latencias y observaciones en `docs/superpowers/notes/`.
4. Seguir el plan por módulo. Hitos: h+3 Tarea 8 desplegada; h+6 Tarea 10; h+9 Tarea 12; h+11 congelar.

Pendientes del equipo: provisionar Supabase (con PostGIS) y Railway; fotos y mensajes de ejemplo para calibrar (los reúne quien tome la Tarea 2).
