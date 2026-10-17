# Radar Urbano — alcance de hackatón

Plan de trabajo · 17 de octubre de 2026 · 15 horas · 3 personas

## 1. Producto y objetivo

Radar Urbano convierte reportes ciudadanos en incidentes ubicados, clasificados y priorizados para que un operador pueda decidir qué atender. El piloto cubre Montevideo.

**Promesa para la demo:** una persona reporta desde su celular sin instalar nada; la IA evalúa la evidencia y el sistema ubica y prioriza el incidente. Si cumple las condiciones de despacho, envía una orden a la cuadrilla disponible más cercana que pueda resolverlo; la cuadrilla la acepta desde su bandeja web.

El chat es el canal de recepción. El valor central del producto es la evaluación estructurada de IA, la consolidación de reportes y la organización del trabajo.

## 2. Decisiones de alcance

| Tema | Decisión para las 15 horas |
| --- | --- |
| Entrada ciudadana | Web móvil accesible por enlace o QR, con chat guiado y botones |
| Instalación / registro | No requeridos para reportar |
| WhatsApp y SMS | Etapa posterior; conservar un contrato común de entrada |
| Cobertura | Montevideo |
| Tipos admitidos | Baches, basura acumulada, veredas o rampas obstruidas |
| Evidencia | Texto, foto opcional y ubicación confirmada |
| IA | Un proveedor real, seleccionado mediante una prueba inicial |
| Dashboard | Lista principal, mapa complementario, filtros y detalle |
| Usuarios internos | Un operador de demo; sin gestión de equipos o roles |
| Cuadrillas | Tres equipos de demo precargados, con ubicación, disponibilidad y especialidades |
| Despacho | Automático bajo condiciones explícitas; recepción y aceptación en bandeja web |
| Seguimiento ciudadano | Código de reporte y consulta desde el mismo navegador |
| Resolución | Cambio manual del operador; evidencia opcional |

**Fuera del MVP:** conexiones oficiales con la Intendencia, GPS continuo de cuadrillas, audio, video, reconocimiento de personas o matrículas, notificaciones externas por WhatsApp/SMS/push, rutas óptimas y cierre automático mediante fotos. La demo debe presentarse como un piloto con cuadrillas de prueba, sin sugerir que los reportes llegan a un servicio municipal real.

## 3. Flujo ciudadano

1. Abre un enlace o QR y ve «Reportá un problema en tu barrio».
2. Escribe qué pasó y puede adjuntar una foto. Ejemplo: «Hay bolsas tapando la rampa».
3. Elige ubicación actual, dirección/esquina o un punto en el mapa. Puede mover el marcador y confirma el lugar del incidente. La ubicación del teléfono es una sugerencia: podría estar reportando algo que vio antes.
4. La IA analiza el reporte y devuelve una ficha breve: tipo de problema, resumen y lugar. La persona puede corregirla.
5. Si falta información indispensable, se pide un dato concreto con botones o una pregunta breve. Máximo dos rondas automáticas; después se conserva como pendiente de revisión.
6. Confirma el envío y recibe un código. El reporte queda guardado aunque el análisis necesite reintento.

No es necesario elegir categoría ni redactar formalmente. Una persona puede completar el reporte solo con texto. El sistema nunca afirma que algo fue reparado por haber recibido el mensaje.

### Respuestas según el caso

| Caso | Comportamiento |
| --- | --- |
| Foto y texto claros, ubicación confirmada | Crear reporte y proponer incidente |
| Texto sin foto | Aceptar; indicar que no hay evidencia visual |
| Falta ubicación | Pedir esquina, dirección o punto; conservar como pendiente |
| Foto poco clara | Pedir otra foto o descripción; permitir revisión manual |
| Saludo o mensaje ajeno al servicio | Explicar qué se puede reportar; no crear incidente público |
| Problema urbano fuera de las tres categorías | Guardar en revisión como «otro» |
| Fuera de Montevideo | Informar cobertura; no ubicarlo dentro del piloto |
| Posible duplicado | Conservar el reporte y asociarlo o sugerir asociación con un incidente |
| Falla del proveedor de IA | Mostrar «Recibido, pendiente de análisis» y permitir reintentar |

## 4. IA de decisiones

El patrón de la captura compartida encaja: preguntas concretas, opciones definidas y resultados estructurados. La selección entre Jev y OpenAI se decide con ejemplos reales durante la primera hora. Las capacidades exactas, credenciales y formatos se verifican en ese momento; este plan no presupone una API particular.

### Parámetros de evaluación

| Campo | Valores / formato | Uso |
| --- | --- | --- |
| Aplicabilidad | aplicable / no relacionado / información insuficiente | Separar incidentes de ruido sin perder casos ambiguos |
| Tipo | bache / basura / accesibilidad / otro / desconocido | Filtrar y organizar |
| Severidad observada | baja / media / alta / indeterminada | Estimar impacto a partir de evidencia disponible |
| Paso bloqueado | sí / no / desconocido | Detectar afectación a la circulación |
| Accesibilidad afectada | sí / no / desconocido | Detectar rampa o recorrido peatonal inutilizable |
| Evidencia | Resumen breve de hechos visibles o declarados | Explicar la evaluación |
| Fuente de cada observación | foto / texto ciudadano | Distinguir lo observado de lo reportado |
| Contradicción texto-foto | sí / no / indeterminada, con motivo | Derivar casos inconsistentes a revisión |
| Ubicación mencionada | Calle, esquina o referencia textual, si existe | Ayudar a buscar la dirección |
| Información faltante | Lista de campos | Guiar el siguiente paso |
| Requiere revisión | sí / no, con motivo | Evitar decisiones automáticas sin suficiente evidencia |

**Severidad:** baja para afectación limitada con paso disponible; media para obstrucción parcial o deterioro que dificulta el uso; alta para bloqueo total o evidencia de riesgo importante; indeterminada cuando falta contexto. Cada categoría debe tener ejemplos de referencia. La IA no estima profundidad exacta de un bache desde una foto sin escala.

**Confianza:** mostrarla solo si el proveedor la ofrece con una semántica conocida. Un porcentaje generado por un modelo no se considera una probabilidad calibrada. Para la interfaz inicial alcanza con «evaluado» y «necesita revisión», más la evidencia y el motivo.

Para el despacho, conservar por separado las puntuaciones de aplicabilidad y tipo si el proveedor las ofrece. La confianza indica cuánta certeza hay sobre la clasificación; la severidad indica el impacto del problema. El umbral y el tratamiento cuando no existe una puntuación adecuada se definen en la sección de cuadrillas.

**Ubicación:** la IA puede extraer una dirección escrita. El geocodificador propone coordenadas, el ciudadano las confirma y el GeoJSON determina el barrio. No se infieren coordenadas a partir de la apariencia de una foto.

### Prioridad operativa

La prioridad combina los resultados de IA con reglas visibles. No representa una medida científica de riesgo ni un SLA municipal.

- **Alta:** severidad alta, bloqueo total del paso o afectación confirmada por la evidencia a una rampa/recorrido accesible.
- **Media:** severidad media, o incidente de prioridad baja con más de 48 horas abierto.
- **Baja:** severidad baja, sin agravantes identificados.
- **Por revisar:** aplicabilidad, severidad o evidencia contradictoria sin resolver. Esta bandeja se muestra de forma prominente.

Dentro de cada nivel, ordenar por mayor antigüedad. Mostrar cantidad de reportes como contexto y permitir ordenar por ella, sin elevar automáticamente la prioridad: repetir mensajes no debe convertirlos en una emergencia.

El operador puede corregir tipo, prioridad, ubicación y estado. Se conserva el resultado original de IA, la versión de la evaluación y la corrección manual.

### Selección del proveedor — máximo 45 minutos

Probar el mismo esquema y unos 10 casos con el proveedor que ya tenga credenciales disponibles: tres categorías válidas, texto sin foto, foto ambigua, mensaje basura, ubicación ausente, contradicción y distintos niveles de severidad. Evaluar estructura válida, utilidad de la clasificación, tiempo de respuesta y facilidad de integración.

Elegir uno. Implementar una función `evaluateReport` que devuelva el esquema interno validado. Un formato inválido o un error produce revisión/reintento, nunca un reporte descartado en silencio. Registrar proveedor, modelo y versión de instrucciones. No construir un sistema de comparación de modelos durante la hackatón.

## 5. Ubicación y barrios

- Guardar coordenadas confirmadas y texto de ubicación; usar longitud/latitud en GeoJSON.
- Resolver barrio mediante punto dentro de polígono, incluyendo geometrías MultiPolygon.
- Fuente descargada y revisada: EPSG:4326, nombre en `properties.barrio`, identificador en `properties.ogc_fid`.
- Si no se obtiene coincidencia, mostrar «Barrio sin determinar»; no asignar el barrio más cercano automáticamente.
- Usar la copia local para que la demo no dependa de la disponibilidad del WFS.

**Archivo disponible:** [barrios-montevideo.geojson](./barrios-montevideo.geojson), descargado el 17 de octubre de 2026 desde [IDE Uruguay — WFS barrios de Montevideo](https://mapas.ide.uy/geoserver-vectorial/ws_capa_base/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=ws_capa_base%3Abarrios_montevideo&outputFormat=application%2Fjson&srsName=EPSG%3A4326). Contiene 62 features, todas MultiPolygon, con 62 identificadores únicos. Se verificó estructura, propiedades y orden de coordenadas de muestra; queda probar la asignación espacial con puntos conocidos al implementar.

## 6. Reportes duplicados

Un **reporte** es un mensaje ciudadano con su evidencia. Un **incidente** es el problema que se gestiona y puede reunir varios reportes.

Para el MVP, buscar candidatos del mismo tipo, abiertos, dentro de aproximadamente 30 metros y con actividad en los últimos 7 días. Estos son parámetros iniciales a validar, no garantía de que sea el mismo problema.

Mostrar al operador «Posible duplicado» y permitir asociarlo con un clic, comparando fotos, descripción y ubicación. La asociación es reversible. Dos baches cercanos pueden ser distintos; la proximidad sola no justifica una unión automática. La comparación semántica con IA es una mejora si sobra tiempo.

Un candidato a duplicado pendiente de revisión bloquea un nuevo despacho automático. Si se asocia a un incidente ya asignado, agrega evidencia a la orden existente sin emitir otra.

### Cuadrillas y despacho automático

**Alcance:** tres cuadrillas de demostración con ubicaciones precargadas y editables. Una pantalla móvil sencilla por cuadrilla muestra sus órdenes y permite aceptar, rechazar, iniciar y finalizar el trabajo. La entrega es una orden persistida en su bandeja web, visible mediante actualización periódica. No requiere un número telefónico.

**Modelo `Crew` (cuadrilla):** `id`, `name`, `capabilities` (bache/basura/accesibilidad), `latitude`, `longitude`, `locationUpdatedAt`, `status` (disponible/reservada/ocupada/fuera de servicio) y `serviceRadiusMeters`. Para el MVP, cada cuadrilla admite una sola orden activa. Las coordenadas de demo se identifican como simuladas.

**Modelo `Assignment` (orden):** `id`, `incidentId`, `crewId`, `status` (ofrecida/aceptada/en curso/completada/rechazada/cancelada), `createdAt`, `acceptedAt`, `completedAt`, `distanceMeters`, resumen de la evidencia y motivo de selección, versión de la política y evaluación utilizada. Entrega a la bandeja y aceptación son eventos distintos.

**Condiciones para automatizar:**

1. Reporte confirmado por el ciudadano, aplicable y de tipo admitido, con análisis validado.
2. Ubicación confirmada dentro de la cobertura, severidad determinada, sin contradicciones ni revisión pendiente.
3. Sin candidato duplicado pendiente y sin orden activa para ese incidente.
4. Confianza suficiente en aplicabilidad y tipo. Como punto de partida de demo, exigir ambas puntuaciones ≥ 0,90 si el proveedor entrega puntuaciones documentadas en esa escala. Es un umbral experimental que se contrasta con los ejemplos, no una precisión garantizada del 90 %. Si no existe una puntuación adecuada, el operador valida el incidente y habilita su asignación; no se inventa un porcentaje. La decisión de proveedor en la primera hora debe verificar este requisito para mostrar automatización completa.
5. Al menos una cuadrilla disponible, con capacidad compatible, ubicación reciente y dentro de su radio de servicio.

**Selección:** filtrar cuadrillas elegibles y calcular distancia geográfica en línea recta; elegir la más cercana. Radio inicial de demo: 3 km; ubicación vigente: actualizada hace menos de 30 minutos. Son parámetros configurables de la prueba. Mostrar «distancia aproximada»; no presentar esta distancia como tiempo de viaje. Si varios incidentes compiten por una cuadrilla, procesarlos por prioridad y luego antigüedad.

**Entrega:** crear la orden y reservar la cuadrilla en una operación atómica. La bandeja recibe tipo, prioridad y motivo, dirección, barrio, coordenadas, descripción y fotos del incidente. Al aceptar, la cuadrilla pasa a ocupada. Al completar, se resuelve el incidente y queda disponible. Rechazar o cancelar libera la cuadrilla y devuelve el incidente a revisión manual; no generar un ciclo de reenvíos automáticos.

**Sin candidato:** mantener «Pendiente de cuadrilla», con el motivo visible: sin equipo compatible, fuera de radio, ocupado o ubicación desactualizada. Un botón permite volver a evaluar disponibilidad. El operador puede cancelar y reasignar una orden.

**Consistencia:** una orden activa por incidente y por cuadrilla, protegida mediante transacción y restricciones de base de datos. Los reintentos no deben crear otra orden. Si se corrige tipo o ubicación con una orden activa, exigir revisión de esa asignación y registrar el cambio.

La gravedad define el orden de atención; la confianza habilita automatización. Un incidente de gravedad alta y confianza baja queda destacado para revisión. Un caso de gravedad baja y confianza alta puede asignarse si existe capacidad disponible.

## 7. Dashboard accesible

La vista inicial responde «¿Qué requiere atención y dónde está?» con una lista legible. El mapa es una vista complementaria; toda tarea esencial debe poder completarse desde la lista.

**Pantalla principal:** contadores simples de pendientes, por revisar y resueltos; buscador por calle o código; filtros por barrio, tipo, prioridad y estado; orden por prioridad, antigüedad y cantidad de reportes. Por defecto, mostrar abiertos por prioridad y luego por antigüedad. Un botón visible limpia todos los filtros.

**Cada fila o tarjeta:** problema en lenguaje cotidiano, barrio/calle, prioridad escrita, antigüedad, estado y número de reportes. Los pendientes de ubicación aparecen en una bandeja, aunque no puedan mostrarse en el mapa.

**Detalle:** foto, descripción, mapa pequeño, evaluación de IA con su evidencia, reportes asociados e historial. Acciones claras: «Corregir datos», «Asociar a incidente», «Marcar en atención» y «Marcar resuelto».

**Asignación:** mostrar cuadrilla, estado de la orden, distancia aproximada y explicación de por qué se asignó o quedó pendiente. Agregar filtro «Sin asignar / Con orden / En curso» y una vista simple de disponibilidad de cuadrillas. La bandeja móvil de cada cuadrilla usa tarjetas y botones grandes; no necesita el dashboard completo. Las sesiones de demo se preconfiguran sin construir administración de usuarios.

**Criterios de accesibilidad:** controles táctiles de al menos 44 × 44 px, texto base de 16 px o mayor, etiquetas visibles, contraste WCAG AA, foco de teclado visible y mensajes de error junto al campo. Colores acompañados por texto e iconos. Evitar acciones que dependan solo de arrastrar el mapa. Anunciar el resultado del envío y los errores a lectores de pantalla.

## 8. Arquitectura mínima

```text
Web móvil / chat guiado
          │
          ▼
API de reportes ───► base de datos + fotos
          │
          ▼
Evaluación IA ───► validación del resultado
          │
          ▼
Ubicación + barrio + prioridad + candidatos duplicados
          │
          ▼
Política de despacho ───► orden + reserva de cuadrilla
          │                         │
          ▼                         ▼
Dashboard del operador      Bandeja web de cuadrilla

Después: WhatsApp y SMS ───► adaptadores ───► misma API de reportes
```

Usar el stack que el equipo ya domine. Si no existe preferencia: aplicación web TypeScript, Postgres y almacenamiento de imágenes administrados, con una librería de mapas compatible con GeoJSON. La elección concreta de hosting, geocodificador y mapas se cierra en la primera hora, comprobando credenciales y condiciones de uso.

El backend guarda primero el reporte y registra el estado del análisis. Para esta escala alcanza un procesamiento simple y reintentos manuales, sin introducir infraestructura compleja. El dashboard puede actualizarse por polling o un botón de actualizar.

### Entidades mínimas

- `Report`: identificador, canal, identificador externo opcional, sesión, texto, fotos, fecha, coordenadas confirmadas, estado del análisis y evaluación de IA.
- `Incident`: tipo, resumen, ubicación, barrio, severidad, prioridad y motivo, estado, fechas de creación/resolución.
- `ReportIncident`: asociación entre reporte e incidente.
- `Event`: correcciones, asociaciones y cambios de estado, con fecha y origen.
- `Crew`: ubicación, fecha de actualización, capacidades, radio de servicio y disponibilidad.
- `Assignment`: orden de trabajo vinculada al incidente y la cuadrilla, estado e historial de entrega/aceptación.

La entrada común admite `channel`, `externalMessageId`, `sessionId`, `text` y `attachments`. Usar identificadores idempotentes para que un reintento no cree reportes repetidos. Los datos específicos del canal se resuelven en su adaptador.

Guardar claves de IA solo en el servidor; limitar tamaño y tipo de archivos. El dashboard del operador debe tener acceso protegido. Los teléfonos que se incorporen con WhatsApp/SMS no se muestran públicamente.

## 9. WhatsApp y SMS después de la hackatón

WhatsApp recibe texto, fotos y ubicación mediante un proveedor habilitado. SMS admite texto y una dirección/esquina; una foto requeriría un enlace web opcional, sin asumir soporte de imágenes por SMS. Ambos alimentan el mismo flujo de evaluación y registro.

Antes de prometer disponibilidad, verificar número, habilitación, webhooks y restricciones del proveedor para respuestas y seguimiento. La demo de hoy usa el canal web real y presenta estas integraciones como trabajo futuro.

## 10. Reparto de 15 horas

Tres personas aportan hasta 45 horas-persona, incluyendo integración y presentación. Acordar los contratos al inicio y conectar una versión mínima antes de pulir pantallas.

| Tiempo | Persona A — recepción | Persona B — IA y datos | Persona C — operación |
| --- | --- | --- | --- |
| 0–1 h | Flujo móvil y contrato de entrada | Prueba de IA/confianza, esquema y persistencia | Estructura dashboard, GeoJSON y mapas |
| 1–4 h | Chat guiado, texto/foto, ubicación | Endpoint, almacenamiento, evaluación validada | Lista, detalle y mapa con datos de prueba identificados |
| 4–7 h | Envío real, confirmación y bandeja móvil de cuadrilla | Prioridad, barrio, candidatos duplicados y datos de cuadrillas | Conexión a datos reales, filtros y orden |
| 7–10 h | Aceptar/rechazar órdenes, errores y accesibilidad | Política de despacho, reserva atómica e idempotencia | Estados, asociación manual y asignación visible |
| 10–12 h | Pruebas de punta a punta entre los tres; completar casos críticos y accesibilidad básica | | |
| 12–13 h | Despliegue y verificación en celulares reales; congelar funcionalidades | | |
| 13–15 h | Preparar ejemplos, practicar pitch y reservar tiempo para fallas | | |

**Hitos:** hora 4, crear y listar un reporte real; hora 7, evaluarlo con IA y ubicarlo; hora 10, enviar una orden a una cuadrilla de demo y aceptarla; hora 12, recorrido completo estable.

**Si hay atrasos:** recortar primero animaciones, seguimiento ciudadano dedicado, comparación visual de duplicados y personalizaciones del mapa. Usar cuadrillas precargadas en lugar de construir su formulario de administración. Conservar recepción web, evaluación real de IA, ubicación confirmada, lista filtrable, revisión humana y el recorrido mínimo de orden/aceptación. Agregar despacho consume parte del margen: no sumar otros canales durante estas 15 horas.

## 11. Criterios de terminado

- Desde un celular, se puede enviar un reporte sin cuenta y sin instalar una app.
- Un reporte válido con foto se evalúa mediante el proveedor real y aparece en el dashboard.
- Un reporte solo con texto también se procesa; la ausencia de foto queda explícita.
- Un mensaje ajeno al servicio no genera un incidente y recibe una orientación útil.
- Una ubicación ausente o ambigua se solicita; nunca se inventan coordenadas.
- Una coordenada conocida recibe el barrio correcto usando el GeoJSON incorporado.
- El operador filtra por barrio, tipo, prioridad y estado, y cambia el orden.
- Dos reportes candidatos pueden asociarse a un incidente y desasociarse.
- El operador puede corregir una evaluación y marcar un incidente como resuelto.
- Ante un error de IA, el reporte persiste y se puede reintentar sin duplicarlo.
- El flujo principal funciona con teclado y la información de prioridad se entiende sin colores.
- Un incidente elegible selecciona la cuadrilla disponible y compatible más cercana y crea una sola orden.
- La cuadrilla ve los datos en su bandeja, acepta y completa la orden; el operador ve cada transición.
- Un incidente con baja confianza o posible duplicado no dispara una orden automática.
- Una cuadrilla ocupada, incompatible o con ubicación desactualizada no se selecciona; si no hay candidatas, el incidente queda pendiente.
- Dos intentos concurrentes no asignan una cuadrilla a dos incidentes ni duplican una orden.

Verificar estos recorridos con casos preparados y fotos que el equipo pueda usar. Medir latencia observada durante las pruebas; no prometer porcentajes de precisión a partir de una muestra pequeña.

## 12. Demo de tres minutos

1. **0:00–0:25:** presentar el problema: reportar debe ser fácil y convertir reportes en trabajo organizado lleva esfuerzo.
2. **0:25–1:10:** escanear QR, subir foto de una rampa bloqueada, confirmar ubicación y enviar.
3. **1:10–1:40:** mostrar el incidente en el dashboard, su barrio, prioridad y condiciones de despacho.
4. **1:40–2:15:** mostrar la cuadrilla compatible más cercana seleccionada; abrir su bandeja en otro celular y aceptar la orden.
5. **2:15–2:45:** mostrar un segundo reporte asociado sin doble despacho y un caso ambiguo que queda en revisión.
6. **2:45–3:00:** mostrar el estado actualizado y explicar la expansión a WhatsApp/SMS.

Preparar incidentes de demostración claramente identificados y una grabación de respaldo. La presentación debe distinguir resultados en vivo, datos precargados y funciones futuras.

## 13. Pendientes concretos para empezar

1. GeoJSON incorporado y estructura revisada; al implementar, probar barrio para coordenadas conocidas.
2. Confirmar credenciales de un proveedor de IA y ejecutar la prueba inicial, incluyendo disponibilidad y significado de puntuaciones de confianza.
3. Elegir el stack que ya conozca el equipo y asignar A/B/C.
4. Reunir fotos y mensajes de ejemplo para las tres categorías y los casos de descarte/revisión.
5. Cerrar el contrato de entrada y salida para trabajar en paralelo.
6. Preparar tres cuadrillas ficticias con ubicaciones, capacidades y estados que permitan demostrar selección, incompatibilidad y ausencia de disponibilidad.
