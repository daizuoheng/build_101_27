# Backlog del módulo Recepción y móvil

Pendientes que quedaron abiertos en `feat/llm-recepcion`. Cada uno dice de quién depende.

## Integración con otros módulos

- [ ] **Conectar `transitionAssignment`** (depende de Operación). Hoy `src/server/unit/dispatch-port.ts` exporta `null` y `POST /api/unidad/assignments/[id]` responde 503 `dispatch_unavailable`. Cuando `src/server/dispatch/transitions.ts` esté en la épica: cambiar esa línea por `export { transitionAssignment } from "../dispatch/transitions";`, correr `tests/db/unit-inbox.test.ts` y probar Aceptar → Iniciar → Completar y Rechazar contra el dominio real.
- [ ] **Errores de `transitionAssignment`**: confirmar con Operación que versión vieja o transición inválida lanzan `DomainError` 409, y que una orden de otra unidad lanza 403. La ruta los traduce tal cual. Si usan otros códigos, ajustar la UI.
- [ ] **Idempotencia de acciones de unidad**: hoy se guarda en `events` (`kind = 'unit_action'`, clave en `data`) con un advisory lock, porque no hay columna. Si Operación también implementa idempotencia dentro de `transitionAssignment`, quedarnos con una sola. Si queremos una tabla o columna dedicada, pedírsela al Núcleo.
- [ ] **Fotos en la bandeja: falta `GET /api/files/[attachmentId]`**. El contrato `UnitAssignmentCard.photoIds` la referencia, pero no existe en ninguna rama. Tiene que autorizar por sesión interna: la unidad de la orden o el operador del territorio. Definir el dueño (storage es de Operación) antes de armar la UI de la bandeja.
- [ ] **Avisar al equipo sobre `src/server/unit/`** (`inbox`, `actions`, `dispatch-port`): carpeta nueva del módulo Recepción, que no estaba listada en el HANDOFF.

## Recepción

- [ ] **Pin propuesto por corrección que se pierde**: si la persona escribe otra cosa sin confirmar el pin nuevo, la ficha vuelve a mostrar la dirección anterior. Decidir con los diseños si el pin pendiente se mantiene visible o se vuelve a ofrecer.
- [ ] **Esquinas**: Nominatim no resuelve “Rivera y Comercio” (ver `jev-smoke.md`). En ese caso la UI cae al mapa. Evaluar otro proveedor solo si en la demo hace falta.
- [ ] **Costo por mensaje**: después de la ficha lista, cada texto nuevo dispara una llamada a `interpret_correction`. No cuenta como ronda de repregunta. Si se abusa, limitarlo por política.
- [ ] **`smoke-llm` en el CLI** (Tarea 13): no existe el subcomando. `scripts/cli.ts` es del Núcleo y solo admite agregar entradas. Lo probado está en `notes/llm-recepcion-smoke.md`.

## Frontend (cuando lleguen los diseños)

- [ ] Bandeja `/unidad`: tarjetas grandes, botones según `allowedActions`, polling cada 10 s, refresco ante 409 y aviso si responde 503.
- [ ] Chat: mostrar repreguntas `origin = llm` y el pin `propose_location` que llega después de una corrección.
- [ ] Probar `/reportar/montevideo` desde un celular real: GPS, cámara, HEIC de iPhone y mapa (A.1).

## Entorno y documentación

- [ ] `pnpm typecheck` en un clon nuevo falla con `RouteContext` hasta correr `pnpm next typegen`. Proponer al Núcleo agregarlo al script `typecheck` o a `postinstall`.
- [ ] Variables vacías en `.env.local` (por ejemplo `TYPESAFE_API_KEY=`) tapan las de `.env`, porque `.env.local` se carga primero. Avisar en el HANDOFF o comentar esas líneas en `.env.example`.
- [ ] `node --env-file=.env.local --env-file=.env scripts/e2e-walkthrough.mjs`: si `.env` tiene `DEMO_OPERATOR_PASSWORD=` vacía, la pisa y se saltea el paso del operador.
