# Backlog del módulo Recepción y móvil

Pendientes que quedaron abiertos en `feat/llm-recepcion`. Cada uno dice de quién depende.

## Integración con otros módulos

- [ ] **Conectar `transitionAssignment`** (depende de Operación). Hoy `src/server/unit/dispatch-port.ts` exporta `null` y `POST /api/unidad/assignments/[id]` responde 503 `dispatch_unavailable`. Cuando `src/server/dispatch/transitions.ts` esté en la épica: cambiar esa línea por `export { transitionAssignment } from "../dispatch/transitions";`, correr `tests/db/unit-inbox.test.ts` y probar Aceptar → Iniciar → Completar y Rechazar contra el dominio real.
- [ ] **Errores de `transitionAssignment`**: confirmar con Operación que versión vieja o transición inválida lanzan `DomainError` 409, y que una orden de otra unidad lanza 403. La ruta los traduce tal cual. Si usan otros códigos, ajustar la UI.
- [ ] **Idempotencia de acciones de unidad**: hoy se guarda en `events` (`kind = 'unit_action'`, clave en `data`), acotada a la orden para usar `events_entity_idx` y serializada con un advisory lock. La base no la garantiza. **Pedir al Núcleo** una migración con un índice único parcial, por ejemplo `events ((data->>'idempotency_key'), entity_id) where kind = 'unit_action'`, o una tabla dedicada (hallazgo del reviewer en el PR #6). Si Operación también implementa idempotencia dentro de `transitionAssignment`, quedarnos con una sola.
- [x] ~~Fotos en la bandeja~~: resuelto en `feat/ui-recepcion` con `GET /api/unidad/photos/[attachmentId]` (unidad con orden activa) y `GET /api/reportar/drafts/[id]/photos/[attachmentId]` (dueño del borrador); sirven el derivado JPEG. **Avisar a Operación**: el contrato menciona `/api/files/[attachmentId]`; si el operador necesita fotos, la ruta es de ellos o se unifica.
- [ ] **Avisar al equipo sobre `src/server/unit/`** (`inbox`, `actions`, `dispatch-port`): carpeta nueva del módulo Recepción, que no estaba listada en el HANDOFF.

## Recepción

- [x] ~~Pin propuesto por corrección que se pierde~~: resuelto en el PR #6. Mientras haya un pin de corrección sin confirmar, se vuelve a ofrecer en lugar de la ficha lista.
- [ ] **Enviar con un pin pendiente**: el botón «Enviar reporte» sigue habilitado mientras hay un pin de corrección sin confirmar, y se enviaría la dirección anterior. Decidir con los diseños si se bloquea hasta que la persona elija: aceptar el pin o quedarse con la dirección actual.
- [ ] **Esquinas**: Nominatim no resuelve “Rivera y Comercio” (ver `jev-smoke.md`). En ese caso la UI cae al mapa. Evaluar otro proveedor solo si en la demo hace falta.
- [ ] **Costo por mensaje**: después de la ficha lista, cada texto nuevo dispara una llamada a `interpret_correction`. No cuenta como ronda de repregunta. Si se abusa, limitarlo por política.
- [ ] **`smoke-llm` en el CLI** (Tarea 13): no existe el subcomando. `scripts/cli.ts` es del Núcleo y solo admite agregar entradas. Lo probado está en `notes/llm-recepcion-smoke.md`.

## Frontend (`feat/ui-recepcion`)

- [x] Chat según los diseños de Stitch: todo conversacional, respuestas sugeridas dentro del chat, ficha para revisar antes de enviar, columna lateral en desktop.
- [x] Bandeja `/unidad`: tarjetas, botones según `allowedActions`, polling cada 10 s, refresco ante 409 y aviso ante 503.
- [ ] **Diseño de la bandeja `/unidad`**: no hay pantalla en Stitch; está armada con el mismo sistema visual. Validar con quien diseña.
- [ ] **Accesos del diseño sin funcionalidad**: no se implementaron «Seguimiento con código» ni los botones de tamaño de texto y contraste. Agregarlos solo si se construye la función.
- [ ] Probar desde un celular y un navegador reales sobre el despliegue: permisos de ubicación, cámara, HEIC de iPhone, Safari y Firefox. Se probó con Chrome headless en viewport mobile y desktop.

## Entorno y documentación

- [ ] `pnpm typecheck` en un clon nuevo falla con `RouteContext` hasta correr `pnpm next typegen`. Proponer al Núcleo agregarlo al script `typecheck` o a `postinstall`.
- [ ] Variables vacías en `.env.local` (por ejemplo `TYPESAFE_API_KEY=`) tapan las de `.env`, porque `.env.local` se carga primero. Avisar en el HANDOFF o comentar esas líneas en `.env.example`. Lo mismo pasa con `DEMO_*_PASSWORD` distintas entre los dos archivos: las cuentas de demo quedan con la contraseña de la primera seed y no se actualizan.
