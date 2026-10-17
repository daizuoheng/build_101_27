# Núcleo C — Despliegue, recorrido final y handoff — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (modo nativo: son tareas operativas con verificación manual, no de código). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desplegar `main` en Railway + Supabase, probar el recorrido completo desde celulares reales y dejar `HANDOFF.md` con el estado verdadero.

**Architecture:** No hay código nuevo salvo correcciones que surjan del despliegue. Todo lo técnico del despliegue ya está decidido y documentado en `docs/superpowers/notes/despliegue.md` ("Pasos cuando lleguen las cuentas" y "Bloqueado hasta tener cuentas"); este plan **ejecuta** esa nota, registra lo que estaba marcado "sin verificar" y agrega el guion de demo. `main` ya tiene todo Núcleo (PR #15, `18e645a`); se despliega `main` y, cuando entren los planes A y B, se redespliega solo.

**Tech Stack:** Railway (Railpack, `.railway/railway.ts`), Supabase (Postgres + PostGIS, Storage privado), `pnpm cli`.

**Spec:** `docs/superpowers/specs/2026-10-17-radar-urbano-design.md` §9 (marco operativo: demo desde celulares reales por internet, dashboard en Mac) y `docs/superpowers/notes/despliegue.md`. Plan madre: Tarea 8 paso 6 y Tarea 15 paso 5 de `docs/superpowers/plans/2026-10-17-radar-urbano-mvp.md`.

## Global Constraints

- **Nunca imprimir secretos** (claves de Jev, DeepSeek, Supabase, contraseñas de demo). Van por variables de Railway y por el gestor del equipo.
- `main` es la rama que Railway despliega: nada se prueba en producción desde una rama.
- Pooler de Supabase en **modo sesión, puerto 5432**; `createPool` rechaza 6543 a propósito.
- Seeds solo a mano y una vez (`pnpm cli migrate && pnpm cli seed && pnpm cli seed-demo`); nunca en el despliegue.
- Las posiciones de demo vencen a los 30 min (`dispatch.position_max_age_min`): `pnpm cli refresh-demo-positions` **inmediatamente antes** de cada ensayo y de la demo.
- Flujo de PR de `AGENTS.md`: loop de `code-review`, Tenki, merge si limpio.

## Review Focus

1. Un redeploy del `worker` en Railway con un job en curso: debe verse `worker detenido` en los logs y el job terminar o volver a `pending` por lease vencido (drenaje de 120 s). Verificación en Task 1 paso 6.
2. Supabase corta conexiones ociosas del pooler: el worker debe seguir vivo (`pg: conexión perdida` en el log, no caída del proceso). Dejar el worker 20 min sin tráfico y confirmar en Task 1.
3. Fotos HEIC de iPhone y fotos verticales con EXIF: el derivado para Jev tiene que verse rotado bien en el detalle del incidente. Parte del guion de Task 2.
4. Dos reportes del mismo lugar desde dos celulares distintos (dos `citizen_session_id`): deben agruparse y el incidente mostrar 2 fuentes; si Jev duda, aparece en la cola de revisión y los candidatos quedan bloqueados para despacho. Guion de Task 2.
5. Demo sin red o con Jev lento: el chat responde con `pending_analysis` y el reporte igual se confirma; el worker lo reevalúa después. Ensayar una vez con el celular en modo avión a mitad del chat (Task 2).

---

### Task 1: Desplegar `main` en Railway y Supabase

**Precondición:** cuentas de Railway y Supabase creadas por el equipo; CLI de Railway ≥ 5.42.1 instalada en una Mac del equipo.

**Files:**
- Modify: `docs/superpowers/notes/despliegue.md` (sección nueva "Desplegado el <fecha>": cada "sin verificar" pasa a verificado o a corregido)
- Modify (si hace falta): `.railway/railway.ts`, `package.json#engines`, `src/server/db/pool.ts`, `src/server/storage/supabase.ts`

- [ ] **Step 1: Supabase.** Seguir `despliegue.md` §1 (extensión PostGIS en `extensions`, bucket `report-photos` privado, URL del pooler de sesión, clave de servicio).
- [ ] **Step 2: Base.** Desde una Mac del equipo, `despliegue.md` §2 tal cual (`migrate`, `seed`, `seed-demo` con `DEMO_*_PASSWORD`, `refresh-demo-positions`). Verificar: `select count(*) from areas` ⇒ 62; `select slug from response_units` ⇒ las 4 unidades de demo.
- [ ] **Step 3: Railway.** `despliegue.md` §3. Registrar en la nota qué pasó con los tres puntos "sin verificar": `preserve()` de variables inexistentes en el primer `apply`; dominio generado y `railway config plan` posterior; build de Railpack con Node `26.x` desde `engines` (si falla, fijar la versión exacta en `engines.node` y commitear).
- [ ] **Step 4: Health.** `https://<dominio>/api/health` ⇒ `{"ok":true}`; logs de `web` con `sin migraciones pendientes`; logs de `worker` con `worker … iniciado` y, al minuto, `replanificación periódica` (si el plan B ya está en `main`).
- [ ] **Step 5: Celular.** `despliegue.md` §4 pasos 1–5 por datos móviles. Guardar el `public_code` del reporte de prueba en la nota.
- [ ] **Step 6: Resiliencia.** Redeploy del `worker` con un job en curso ⇒ `worker detenido`; dejar el sistema 20 min quieto ⇒ el `worker` sigue vivo (ver Review Focus 1 y 2).
- [ ] **Step 7: Nota y commit.** Sección "Desplegado el <fecha>" en `despliegue.md` con dominio (sin credenciales), resultados de los pasos 3–6 y cualquier corrección hecha.

```bash
/usr/bin/git add docs/superpowers/notes/despliegue.md .railway package.json
/usr/bin/git commit -m "docs(despliegue): resultado del despliegue real en Railway y Supabase"
```

(PR chico a `main`; si hubo cambios de código, con sus tests.)

---

### Task 2: Guion de demo y recorrido final

**Precondición:** plan A y plan B mergeados a `main` y desplegados; bandeja `/unidad` (Recepción, PR #13) y vistas de Operación (plan, revisión, detalle) en `main`.

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
