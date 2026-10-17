# Núcleo C — Despliegue, recorrido final y handoff — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (modo nativo: son tareas operativas con verificación manual, no de código). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desplegar `main` en Railway + Supabase, probar el recorrido completo desde celulares reales y dejar `HANDOFF.md` con el estado verdadero.

**Architecture:** No hay código nuevo salvo correcciones que surjan del despliegue. **El equipo ya provisionó Railway y Supabase desde sus dashboards** (17 oct, noche) y **cada merge a `main` despliega solo**; ningún commit de ese setup está en el repo (`main` sigue en `18e645a`). Por eso este plan ya no crea infraestructura: **verifica** lo provisionado contra `docs/superpowers/notes/despliegue.md`, resuelve lo marcado "sin verificar", reconcilia `.railway/railway.ts` con lo que existe y agrega el guion de demo. `main` ya tiene todo Núcleo (PR #15).

**Tech Stack:** Railway (Railpack, `.railway/railway.ts`), Supabase (Postgres + PostGIS, Storage privado), `pnpm cli`.

**Spec:** `docs/superpowers/specs/2026-10-17-radar-urbano-design.md` §9 (marco operativo: demo desde celulares reales por internet, dashboard en Mac) y `docs/superpowers/notes/despliegue.md`. Plan madre: Tarea 8 paso 6 y Tarea 15 paso 5 de `docs/superpowers/plans/2026-10-17-radar-urbano-mvp.md`.

## Global Constraints

- **Nunca imprimir secretos** (claves de Jev, DeepSeek, Supabase, contraseñas de demo). Van por variables de Railway y por el gestor del equipo.
- `main` es la rama que Railway despliega, **en cada merge**: todo PR a `main` es un despliegue a producción. Nada se prueba en producción desde una rama.
- **No correr `railway config apply`** hasta reconciliar `.railway/railway.ts` con lo creado en el dashboard (Task 1 paso 3): el IaC es declarativo y marca para borrar servicios y variables que no declara.
- Pooler de Supabase en **modo sesión, puerto 5432**; `createPool` rechaza 6543 a propósito.
- Seeds a mano, nunca en el despliegue. La primera vez: `migrate && seed && seed-demo`. Después, **tras cada merge a `main` que cambie `seeds/policies.ts`, `seeds/templates.ts` o el catálogo, correr `pnpm cli seed` contra Supabase** (`seedAll` republica la política activa que ya no valida); si no, `assess_incident` falla en producción con `PolicyInvalidError`. Las migraciones sí corren solas en el pre-deploy.
- Las posiciones de demo vencen a los 30 min (`dispatch.position_max_age_min`): `pnpm cli refresh-demo-positions` **inmediatamente antes** de cada ensayo y de la demo.
- Flujo de PR de `AGENTS.md`: loop de `code-review`, Tenki, merge si limpio.

## Review Focus

1. Un redeploy del `worker` en Railway con un job en curso: debe verse `worker detenido` en los logs y el job terminar o volver a `pending` por lease vencido (drenaje de 120 s). Verificación en Task 1 paso 6.
2. Supabase corta conexiones ociosas del pooler: el worker debe seguir vivo (`pg: conexión perdida` en el log, no caída del proceso). Dejar el worker 20 min sin tráfico y confirmar en Task 1.
3. Fotos HEIC de iPhone y fotos verticales con EXIF: el derivado para Jev tiene que verse rotado bien en el detalle del incidente. Parte del guion de Task 2.
4. Dos reportes del mismo lugar desde dos celulares distintos (dos `citizen_session_id`): deben agruparse y el incidente mostrar 2 fuentes; si Jev duda, aparece en la cola de revisión y los candidatos quedan bloqueados para despacho. Guion de Task 2.
5. Demo sin red o con Jev lento: el chat responde con `pending_analysis` y el reporte igual se confirma; el worker lo reevalúa después. Ensayar una vez con el celular en modo avión a mitad del chat (Task 2).

---

### Task 1: Verificar el despliegue provisionado por el equipo

**Precondición:** credenciales compartidas por el equipo (por el gestor, nunca por chat ni repo): URL del pooler de sesión de Supabase, clave de servicio, acceso al proyecto de Railway (`railway login` + `railway link`), dominio de `web`.

**Files:**
- Modify: `docs/superpowers/notes/despliegue.md` (sección nueva "Desplegado el <fecha>": qué se provisionó y cómo, cada "sin verificar" pasa a verificado o corregido, y la regla del seed tras cada merge)
- Modify (si hace falta): `.railway/railway.ts`, `package.json#engines`, `src/server/db/pool.ts`, `src/server/storage/supabase.ts`

- [ ] **Step 1: Supabase contra `despliegue.md` §1.** Sin crear nada, verificar en el SQL Editor y el dashboard: `select extname, extnamespace::regnamespace from pg_extension where extname = 'postgis'` (en `extensions` o `public`); `show search_path` la incluye; bucket `report-photos` con `public = false`; la URL que usa Railway es la del **pooler de sesión, puerto 5432**. Cualquier diferencia: corregir en Supabase y anotarla.
- [ ] **Step 2: Base.** Con `DATABASE_URL` de Supabase exportada solo en esa terminal: `pnpm cli migrate` (debe decir `sin migraciones pendientes` si el pre-deploy ya corrió) y, si la base no tiene datos, `pnpm cli seed && pnpm cli seed-demo` (con `DEMO_*_PASSWORD` del gestor). Verificar: `select count(*) from areas` ⇒ 62; `select slug from response_units` ⇒ las 4 unidades de demo; `select kind, version from policy_versions where active` ⇒ 7 filas válidas. Si la base ya estaba sembrada antes del #15, `pnpm cli seed` igual (republica `planning` con `busy_retry_sec`).
- [ ] **Step 3: Railway contra `.railway/railway.ts`.** `railway config pull` a un archivo temporal (no sobre el del repo) y comparar con `.railway/railway.ts`: nombres de servicios (`web`, `worker`), comandos de build/arranque/pre-deploy, healthcheck `/api/health`, `watchPatterns` y variables. Decidir con quien lo provisionó: (a) traer lo real al archivo del repo (PR chico a `main`) para que un `apply` futuro no borre nada, o (b) declarar en `despliegue.md` que la fuente de verdad es el dashboard y que `apply` no se usa. Recomendado (a) si las diferencias son de nombre o variables; (b) si el dashboard tiene servicios que el IaC no modela. Registrar los tres "sin verificar" de la nota: `preserve()` (no aplica si se elige b), dominio generado, build de Railpack con Node `26.x` (ver el log del último build).
- [ ] **Step 4: Health.** `https://<dominio>/api/health` ⇒ `{"ok":true}`; logs de `web` con `sin migraciones pendientes`; logs de `worker` con `worker … iniciado` y, al minuto, `replanificación periódica` (si el plan B ya está en `main`).
- [ ] **Step 5: Celular.** `despliegue.md` §4 pasos 1–5 por datos móviles. Guardar el `public_code` del reporte de prueba en la nota.
- [ ] **Step 6: Resiliencia.** Redeploy del `worker` con un job en curso ⇒ `worker detenido`; dejar el sistema 20 min quieto ⇒ el `worker` sigue vivo (ver Review Focus 1 y 2).
- [ ] **Step 7: Despliegue continuo.** Mergear a `main` un cambio inocuo (por ejemplo, la nota de este paso) y confirmar que `web` y `worker` se redesplegan solos y que `worker` **no** se redespliega si el cambio es solo de `docs/` (por `watchPatterns`). Anotar cuánto tarda de merge a health verde.
- [ ] **Step 8: Nota y commit.** Sección "Desplegado el <fecha>" en `despliegue.md` con: quién provisionó qué y desde dónde (dashboard), dominio (sin credenciales), resultado de los pasos 1–7, la decisión del paso 3 y la regla "tras un merge que cambie seeds de políticas, `pnpm cli seed` contra Supabase". Agregar esa regla también a `AGENTS.md` en la sección del flujo de integración.

```bash
/usr/bin/git add docs/superpowers/notes/despliegue.md AGENTS.md .railway package.json
/usr/bin/git commit -m "docs(despliegue): verificación del despliegue provisionado y regla del seed tras merge"
```

(PR chico a `main`, que se despliega al mergear; si hubo cambios de código, con sus tests.)

---

### Task 2: Guion de demo y recorrido final

**Precondición:** plan A y plan B en `main` (con el despliegue continuo, mergear ya es desplegar); `epic/operacion` en `main` con T11 (#11), T12 (#17) y las vistas; `epic/recepcion` en `main` con la bandeja `/unidad` (#13 → #6). Después del último merge, `pnpm cli seed` contra Supabase si alguno tocó políticas.

**Files:**
- Create: `docs/superpowers/notes/recorrido-final.md`
- Modify (si hace falta): `seeds/demo.ts` (posiciones de las cuadrillas si el guion pide otra geografía)

- [ ] **Step 1: Preparar.** Contra producción (con `DATABASE_URL` de Supabase exportada solo en esa terminal): `pnpm cli reset-demo --yes && pnpm cli refresh-demo-positions`. Confirmar `select count(*) from incidents` ⇒ 0.
- [ ] **Step 2: Guion (escribirlo primero en la nota, después ejecutarlo).** Tres celulares o tres sesiones:
  1. Celular A: bache con foto real y GPS en un punto de Montevideo ⇒ incidente `bache`, banda según severidad, en `/operacion`.
  2. Celular B, a < 30 m del mismo punto, otra foto del mismo pozo ⇒ se agrupa (2 fuentes) o va a revisión `uncertain_duplicate`; en ambos casos mostrarlo.
  3. Celular A: contenedor quemándose (foto de `tests/fixtures/jev/photos/contenedor-quemado.jpg` impresa o en pantalla) ⇒ `active_hazard`, banda alta, requiere capacidad `fuego`.
  4. Mac, operador: corregir severidad del bache (override) ⇒ reevaluación y plan nuevo; mostrar el "Plan de atención" con el orden (fuego primero) y las razones.
  5. Celular C, unidad `fuego+limpieza`: en `/unidad` aparece la orden del contenedor ⇒ Aceptar ⇒ Iniciar ⇒ Completar ⇒ incidente `resolved`.
  6. Operador: rechazar/cancelar una orden ⇒ `review_items(rejected_assignment)` y el incidente no se reenvía solo.
  7. Mostrar los textos del operador (título, resumen, explicación de prioridad) en el detalle.
- [ ] **Step 3: Ejecutar el guion** de punta a punta midiendo tiempos (chat → incidente visible; incidente → orden en la bandeja). Anotar cada desvío con su causa y si se corrige o se declara en la demo.
- [ ] **Step 4: Ensayos de falla** (Review Focus 3–5): HEIC vertical; dos sesiones distintas en el mismo lugar; modo avión a mitad del chat.
- [ ] **Step 5: Correcciones.** Cada bug encontrado: rama desde la épica dueña del archivo, test, fix, PR por el flujo normal. Si el archivo es de otro módulo, abrir issue/avisar en vez de tocarlo.
- [ ] **Step 6: Nota.** `recorrido-final.md`: guion definitivo, tiempos medidos, qué se declara como limitación en la demo (umbrales de Jev, textos deterministas por defecto, etc.) y el checklist de 5 minutos previo a la demo (`refresh-demo-positions`, worker vivo, celulares logueados).

```bash
/usr/bin/git add docs/superpowers/notes/recorrido-final.md
/usr/bin/git commit -m "docs: guion de demo y recorrido final verificado en producción"
```

---

### Task 3: `HANDOFF.md` y `PROMPT-CONTINUAR.md` al día

**Files:**
- Modify: `HANDOFF.md` (reescribir "Estado real"; quitar "Falta: …" obsoleto; dejar hitos cumplidos y lo que quedó fuera)
- Modify: `PROMPT-CONTINUAR.md` (estado: código desplegado; qué leer primero: `recorrido-final.md`, `despliegue.md`; qué queda: roadmap del ALCANCE)

- [ ] **Step 1:** Reescribir `HANDOFF.md` §"Estado real" con: PRs mergeados por módulo, dominio de producción (sin credenciales), cómo correr la demo (checklist de `recorrido-final.md`), cómo correr en local (sin cambios), limitaciones conocidas y roadmap. Conservar "Decisiones cerradas" y "Reglas de convivencia".
- [ ] **Step 2:** Reescribir `PROMPT-CONTINUAR.md` para una sesión posterior a la demo (mantenimiento o roadmap), con la misma estructura de hoy: dónde está el código, qué leer en orden, reglas del repo (hooks, `/usr/bin/git`, `rtk`).
- [ ] **Step 3:** PR chico a `main` (`docs: handoff post-demo`), sin esperar a Tenki más de una pasada.

```bash
/usr/bin/git add HANDOFF.md PROMPT-CONTINUAR.md
/usr/bin/git commit -m "docs: handoff y prompt de continuación con el estado desplegado"
```
