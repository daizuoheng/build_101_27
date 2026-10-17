# Backlog del módulo Recepción y móvil

Pendientes que quedaron abiertos en `feat/llm-recepcion`. Cada uno dice de quién depende.

## Integración con otros módulos

- [ ] **Conectar `transitionAssignment`** (depende de Operación). Hoy `src/server/unit/dispatch-port.ts` exporta `null` y `POST /api/unidad/assignments/[id]` responde 503 `dispatch_unavailable`. Cuando `src/server/dispatch/transitions.ts` esté en la épica: cambiar esa línea por `export { transitionAssignment } from "../dispatch/transitions";`, correr `tests/db/unit-inbox.test.ts` y probar Aceptar → Iniciar → Completar y Rechazar contra el dominio real.
- [ ] **Errores de `transitionAssignment`**: confirmar con Operación que versión vieja o transición inválida lanzan `DomainError` 409, y que una orden de otra unidad lanza 403. La ruta los traduce tal cual. Si usan otros códigos, ajustar la UI.
- [ ] **Idempotencia de acciones de unidad**: hoy se guarda en `events` (`kind = 'unit_action'`, clave en `data`), acotada a la orden para usar `events_entity_idx` y serializada con un advisory lock. La base no la garantiza. **Pedir al Núcleo** una migración con un índice único parcial, por ejemplo `events ((data->>'idempotency_key'), entity_id) where kind = 'unit_action'`, o una tabla dedicada (hallazgo del reviewer en el PR #6). Si Operación también implementa idempotencia dentro de `transitionAssignment`, quedarnos con una sola.
- [ ] **Fotos en la bandeja: falta `GET /api/files/[attachmentId]`**. El contrato `UnitAssignmentCard.photoIds` la referencia, pero no existe en ninguna rama. Tiene que autorizar por sesión interna: la unidad de la orden o el operador del territorio. Definir el dueño (storage es de Operación) antes de armar la UI de la bandeja.
- [ ] **Avisar al equipo sobre `src/server/unit/`** (`inbox`, `actions`, `dispatch-port`): carpeta nueva del módulo Recepción, que no estaba listada en el HANDOFF.

## Recepción

- [x] ~~Pin propuesto por corrección que se pierde~~: resuelto en el PR #6. Mientras haya un pin de corrección sin confirmar, se vuelve a ofrecer en lugar de la ficha lista.
- [ ] **Enviar con un pin pendiente**: el botón «Enviar reporte» sigue habilitado mientras hay un pin de corrección sin confirmar, y se enviaría la dirección anterior. Decidir con los diseños si se bloquea hasta que la persona elija: aceptar el pin o quedarse con la dirección actual.
- [ ] **Esquinas**: Nominatim no resuelve “Rivera y Comercio” (ver `jev-smoke.md`). En ese caso la UI cae al mapa. Evaluar otro proveedor solo si en la demo hace falta.
- [ ] **Costo por mensaje**: después de la ficha lista, cada texto nuevo dispara una llamada a `interpret_correction`. No cuenta como ronda de repregunta. Si se abusa, limitarlo por política.
- [ ] **`smoke-llm` en el CLI** (Tarea 13): no existe el subcomando. `scripts/cli.ts` es del Núcleo y solo admite agregar entradas. Lo probado está en `notes/llm-recepcion-smoke.md`.

## Frontend (cuando lleguen los diseños)

- [ ] Bandeja `/unidad`: tarjetas grandes, botones según `allowedActions`, polling cada 10 s, refresco ante 409 y aviso si responde 503.
- [ ] Chat: mostrar repreguntas `origin = llm` y el pin `propose_location` que llega después de una corrección.
- [ ] Probar `/reportar/montevideo` desde un celular real: GPS, cámara, HEIC de iPhone y mapa (A.1).

## Entorno y documentación

- [ ] `pnpm typecheck` en un clon nuevo falla con `RouteContext` hasta correr `pnpm next typegen`. Proponer al Núcleo agregarlo al script `typecheck` o a `postinstall`.
- [ ] Variables vacías en `.env.local` (por ejemplo `TYPESAFE_API_KEY=`) tapan las de `.env`, porque `.env.local` se carga primero. Avisar en el HANDOFF o comentar esas líneas en `.env.example`. Lo mismo pasa con `DEMO_*_PASSWORD` distintas entre los dos archivos: las cuentas de demo quedan con la contraseña de la primera seed y no se actualizan.

## Canal WhatsApp (roadmap)

- [ ] **Identidad por teléfono**: el adaptador de WhatsApp asocia cada número a una `citizen_session` (`channel = 'whatsapp'`, `external_identity`). **Guardar el número cifrado o como hash con sal (Ley 18.331)**, nunca en texto plano, y no mostrarlo en operación.
- [ ] **Botones y ubicación nativos de WhatsApp**: la Cloud API tiene botones de respuesta (máx. 3), pedido de ubicación y mensajes de ubicación con mapa. El backend ya acepta respuestas por texto («sí», «no», «enviar», el código del reporte), así que los botones son una mejora opcional, no un requisito.
- [ ] **Léxico de respuestas** (`intake.replies` en la política): calibrar con mensajes reales. Hoy solo cuenta como confirmación un mensaje que sea entero una respuesta corta.

## Geocodificación

- [ ] **Límite de ritmo compartido entre instancias**: `nextSlot()` serializa los pedidos a Nominatim dentro de un proceso. Con varias instancias web (o web y worker geocodificando) se puede superar 1 pedido por segundo y el servicio público bloquea por abuso. Opción: geocodificar en un job del worker con un turno compartido en la base, y que el chat responda «estoy buscando la dirección…».
- [ ] **Caché más tolerante**: hoy la coincidencia es exacta («A y B» ≠ «B y A», «esq.» ≠ «y»). Normalizar el orden y los sinónimos, guardar la geometría por calle y hacer que los «no encontrado» venzan.

- [ ] **Esquinas más rápidas**: hoy una esquina no cacheada cuesta de 3 a 4 pedidos a Nominatim (2,5 a 6 s), por el límite de 1 pedido por segundo del servicio público. Ese límite se comparte entre todos los usuarios del proceso, así que con varias personas a la vez se forma cola. Opciones: (1) caché por calle, además de por consulta; (2) importar a PostGIS los ejes de calles de Montevideo (IDE Uruguay / Intendencia) y calcular cruces localmente en milisegundos, sin red; (3) Nominatim propio o un proveedor pago. Recomendado: (2) para el piloto.
