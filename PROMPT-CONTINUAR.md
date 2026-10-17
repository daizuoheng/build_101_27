# Prompt para la nueva sesión

```text
Continuemos Radar Urbano en /Users/fededallo/Desktop/hackaton (repo daizuoheng/build_101_27, rama main).

El diseño y el plan ya están acordados y commiteados; no reabrir brainstorming. Leé en este orden:
1. docs/superpowers/specs/2026-10-17-radar-urbano-design.md (prevalece sobre los demás documentos).
2. docs/superpowers/plans/2026-10-17-radar-urbano-mvp.md (15 tareas, reparto por módulos, interfaces).
3. HANDOFF.md para el estado operativo.

Ejecutá el plan con superpowers:executing-plans en modo nativo, en una rama feat/mvp, con TDD y un commit por tarea. Yo (Claude) soy dueño del módulo "Núcleo y pipeline"; las tareas de Recepción y Operación las toman mis compañeros, así que solo avanzá sobre las tareas de Núcleo salvo que te diga lo contrario. Empezá por la Tarea 1 (esquema PostGIS, migrador, contratos compartidos), que es la base de los tres módulos, y después la Tarea 2 (prueba real de Jev).

Estado: no hay código todavía. Postgres 18 con PostGIS corre local (bases radar_urbano y radar_urbano_test por crear/usar). El .env ya tiene TYPESAFE_API_KEY y LLM_API_KEY (DeepSeek); agregá LLM_BASE_URL=https://api.deepseek.com, LLM_MODEL=deepseek-flash y DATABASE_URL local. Supabase y Railway los provisiona el equipo después; usá adaptadores locales mientras tanto. Nunca imprimas secretos.

Prefijá comandos shell con rtk. Un hook bloquea cat/grep/sed en este repo: usá las herramientas Read/Edit o codedb. Next.js 16 tiene cambios: leé node_modules/next/dist/docs antes de escribir rutas.
```
