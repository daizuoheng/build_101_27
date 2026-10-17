# Radar Urbano — alcance de hackatón

Plan de trabajo · 17 de octubre de 2026 · 15 horas · 3 personas

## 1. Producto y objetivo

Radar Urbano convierte reportes ciudadanos en incidentes ubicados, clasificados y priorizados para que un operador pueda decidir qué atender. El producto es generalizable a distintas ciudades y territorios; Montevideo es únicamente la cobertura inicial del MVP, porque contamos con su GeoJSON de barrios. Incorporar otra ciudad debe requerir datos y configuración, sin modificar la lógica del producto.

**Promesa para la demo:** una persona reporta desde su celular sin instalar nada; la IA evalúa la evidencia, agrupa automáticamente reportes del mismo problema y actualiza su clasificación y prioridad. Si cumple las condiciones de asignación, envía una orden a la unidad de respuesta correspondiente según la política del territorio; esa unidad la acepta desde su bandeja web. En el piloto, las unidades son cuadrillas móviles.

El chat es el canal de recepción. El valor central del producto es la evaluación estructurada de IA, la consolidación de reportes y la organización del trabajo.

## 2. Decisiones de alcance

| Tema | Decisión para las 15 horas |
| --- | --- |
| Entrada ciudadana | Web móvil accesible por enlace, con conversación asistida por LLM y botones de ubicación/confirmación |
| Instalación / registro | No requeridos para reportar |
| WhatsApp y SMS | Etapa posterior; conservar un contrato común de entrada |
| Cobertura | Producto configurable por territorio; MVP habilitado en Montevideo |
| Tipos admitidos | Catálogo persistido ampliable; categorías iniciales detalladas debajo |
| Evidencia | Texto, foto opcional y ubicación confirmada |
| IA de decisiones | Jev para evaluación, agrupación y reevaluación; calidad del piloto pendiente de prueba real |
| LLM generativo | Conversación ciudadana, extracción propuesta de datos, resúmenes y explicaciones basadas en evidencia; OpenAI como proveedor recomendado |
| Dashboard | Lista principal, mapa complementario, filtros y detalle |
| Usuarios internos | Identidades preconfiguradas de operador/unidad, con autorización en servidor; sin interfaz de administración de usuarios |
| Cuadrillas | Tres equipos de demo insertados mediante seed en la base de datos; ubicación, disponibilidad y especialidades consultadas dinámicamente |
| Despacho | Automático bajo condiciones explícitas; recepción y aceptación en bandeja web |
| Planificación operativa | Cola de atención ordenada y propuesta de asignaciones sobre el conjunto de incidentes y recursos disponibles |
| Agrupación | Automática mediante IA cuando hay evidencia suficiente; revisión para casos ambiguos |
| Seguimiento ciudadano | Código de reporte y consulta desde el mismo navegador |
| Resolución | Cierre explícito del operador o al completar una orden desde la unidad autorizada; evidencia opcional |

**Fuera del MVP:** conexiones oficiales con la Intendencia, GPS continuo de cuadrillas, audio, video, reconocimiento de personas o matrículas, notificaciones externas por WhatsApp/SMS/push, rutas óptimas y cierre automático mediante fotos. La demo debe presentarse como un piloto con cuadrillas de prueba, sin sugerir que los reportes llegan a un servicio municipal real.

### Catálogo inicial de problemas

| Tipo | Situaciones a distinguir |
| --- | --- |
| Bache | Deterioro en la calzada |
| Basura acumulada | Residuos fuera del lugar previsto o desborde |
| Accesibilidad obstruida | Rampa, vereda o paso peatonal bloqueado |
| Contenedor dañado | Quemado sin fuego activo, roto o volcado |
| Contenedor con fuego | Fuego activo reportado u observado; atención urgente especializada |
| Vereda rota | Baldosas levantadas, hundimiento o superficie deteriorada |
| Cartelería dañada u obstruida | Cartel roto, caído, tapado o que obstaculiza el paso; distinguir señalización vial de otros carteles |
| Alumbrado público | Luminaria apagada, dañada o intermitente |
| Árbol o rama caída | Obstáculo en vereda o calzada |
| Desagüe obstruido | Sumidero tapado o acumulación de agua asociada |

La IA selecciona del catálogo activo y registra detalles de condición. «Otro» y «desconocido» permiten conservar casos sin una categoría adecuada. Una foto de día no prueba que una luminaria no funcione; registrar la observación del ciudadano como tal.

El fuego activo se distingue del daño posterior a un incendio. Activa una indicación de atención urgente y revisión destacada; el despacho exige capacidad especializada explícita. No se asigna a una cuadrilla de limpieza por compartir el objeto «contenedor». Si no existe un recurso habilitado, informar que no se ha movilizado asistencia y mostrar el canal de emergencia configurado para el territorio, sin inventar teléfonos ni prometer atención.

### Regla obligatoria: datos y configuración sin hardcodear

Está prohibido hardcodear datos operativos en componentes, servicios o prompts: cuadrillas, coordenadas, territorios, categorías, capacidades, umbrales, radios, plazos y contactos. La aplicación consulta datos persistidos y configuración validada; si faltan, muestra un estado vacío o de configuración pendiente, sin insertar equipos ficticios como fallback.

Las seeds versionadas e idempotentes cargan el catálogo, la configuración territorial, las políticas y las cuadrillas de demo en la base de datos. Los valores de ejemplo viven únicamente en los archivos de seed. Reejecutarlas no duplica registros ni resetea órdenes, disponibilidad o cambios del operador; el reset de demo es una operación explícita. Las credenciales se suministran por entorno, nunca desde una seed. Los datos de demo quedan identificados como tales.

Frontend, evaluación de IA y despacho consumen el mismo catálogo: opciones y criterios se construyen desde los datos activos, sin listas duplicadas en código. Los valores numéricos de este documento son valores iniciales para la seed de configuración.

## 3. Flujo ciudadano

1. Abre la web mediante un enlace y ve «Reportá un problema en tu barrio».
2. Escribe qué pasó y puede adjuntar una foto. Ejemplo: «Hay bolsas tapando la rampa».
3. Elige ubicación actual, dirección/esquina o un punto en el mapa. Puede mover el marcador y confirma el lugar del incidente. La ubicación del teléfono es una sugerencia: podría estar reportando algo que vio antes.
4. Persistir el borrador antes de analizar. La IA devuelve una ficha breve: tipo de problema, resumen y lugar. La persona puede corregirla; un cambio de entradas invalida el análisis anterior. El borrador nunca genera órdenes.
5. Si falta información indispensable, se pide un dato concreto con botones o una pregunta breve. Tras dos rondas automáticas sin obtener el dato, ofrecer ingreso directo o conservar como pendiente de revisión; esto no impide que el ciudadano continúe o corrija la conversación.
6. Confirma el envío mediante una operación idempotente y recibe un código. Solo después de confirmar se habilitan agrupación y asignación. El procesamiento retoma desde la etapa pendiente si necesita reintento. El código visible no concede acceso: el seguimiento se autoriza mediante la sesión ciudadana.

No es necesario elegir categoría ni redactar formalmente. Una persona puede completar el reporte solo con texto. El sistema nunca afirma que algo fue reparado por haber recibido el mensaje.

### Respuestas según el caso

| Caso | Comportamiento |
| --- | --- |
| Foto y texto claros, ubicación confirmada | Crear reporte y proponer incidente |
| Texto sin foto | Aceptar; indicar que no hay evidencia visual |
| Falta ubicación | Pedir esquina, dirección o punto; conservar como pendiente |
| Foto poco clara | Pedir otra foto o descripción; permitir revisión manual |
| Saludo o mensaje ajeno al servicio | Explicar qué se puede reportar; no crear incidente público |
| Problema urbano fuera del catálogo activo | Guardar en revisión como «otro» |
| Fuera de los territorios habilitados | Conservar como fuera de cobertura e informar el alcance actual; no asignar a otro territorio ni despachar |
| Posible duplicado | Conservar el reporte y asociarlo o sugerir asociación con un incidente |
| Falla del proveedor de IA | Mostrar «Recibido, pendiente de análisis» y permitir reintentar |

## 4. IA de decisiones

El MVP incorpora dos capacidades: un LLM para lenguaje y Jev para juicios estructurados. El backend coordina ambas y conserva autoridad sobre permisos, confirmación del envío, agrupación y órdenes. Conversar o generar un resumen no equivale a confirmar un reporte ni a despachar. Se conservan mensajes originales y resultados de ambos modelos por separado. Ver el diseño de conversación en [ARQUITECTURA-RADAR-URBANO.md](./ARQUITECTURA-RADAR-URBANO.md).

Proveedor recomendado: Jev. La documentación confirma preguntas tipadas, probabilidades, confianza para Choice/Score y soporte experimental de imágenes. El contrato específico está en [INTEGRACION-JEV.md](./INTEGRACION-JEV.md). Falta probar credenciales, calidad y latencia con nuestros ejemplos. Jev no genera texto libre. Un LLM separado conversa con el ciudadano y redacta resúmenes, aclaraciones y explicaciones desde datos autorizados, resultados de Jev y eventos persistidos. Las plantillas quedan como fallback; el texto generado no sustituye evidencia ni decisiones de Jev.

### Parámetros de evaluación

| Campo | Valores / formato | Uso |
| --- | --- | --- |
| Aplicabilidad | aplicable / no relacionado / información insuficiente | Separar incidentes de ruido sin perder casos ambiguos |
| Tipo | Identificador del catálogo activo / otro / desconocido | Filtrar y organizar sin enumeraciones de negocio hardcodeadas |
| Condición y peligro activo | Detalles según tipo; fuego activo: sí / no / desconocido | Distinguir daño material de una situación urgente y exigir capacidad adecuada |
| Severidad observada | baja / media / alta / indeterminada | Estimar impacto a partir de evidencia disponible |
| Paso bloqueado | sí / no / desconocido | Detectar afectación a la circulación |
| Accesibilidad afectada | sí / no / desconocido | Detectar rampa o recorrido peatonal inutilizable |
| Evidencia | Resumen breve de hechos visibles o declarados | Explicar la evaluación |
| Fuente de cada observación | foto / texto ciudadano | Distinguir lo observado de lo reportado |
| Contradicción texto-foto | sí / no / indeterminada, con motivo | Derivar casos inconsistentes a revisión |
| Ubicación | Campo explícito de dirección/esquina y coordenadas confirmadas | Geocodificar y asignar barrio en backend; no es extracción libre de Jev |
| Información faltante | Lista de campos | Guiar el siguiente paso |
| Requiere revisión | sí / no, con motivo | Evitar decisiones automáticas sin suficiente evidencia |

**Severidad:** baja para afectación limitada con paso disponible; media para obstrucción parcial o deterioro que dificulta el uso; alta para bloqueo total o evidencia de riesgo importante; indeterminada cuando falta contexto. Cada categoría debe tener ejemplos de referencia. La IA no estima profundidad exacta de un bache desde una foto sin escala.

**Confianza:** mostrarla solo si el proveedor la ofrece con una semántica conocida. Un porcentaje generado por un modelo no se considera una probabilidad calibrada. Para la interfaz inicial alcanza con «evaluado» y «necesita revisión», más la evidencia y el motivo.

Para el despacho, conservar por separado las puntuaciones de aplicabilidad y tipo si el proveedor las ofrece. La confianza indica cuánta certeza hay sobre la clasificación; la severidad indica el impacto del problema. El umbral y el tratamiento cuando no existe una puntuación adecuada se definen en la sección de cuadrillas.

**Ubicación:** el LLM puede proponer dirección/esquina extraída del mensaje, con referencia al texto original; el ciudadano también puede ingresarla en un campo propio o seleccionar un punto. El geocodificador propone coordenadas, el ciudadano las confirma y el GeoJSON determina el barrio. Jev no extrae direcciones libres ni se infieren coordenadas desde la apariencia de la foto.

### Prioridad operativa

La prioridad combina los resultados de IA con reglas visibles. No representa una medida científica de riesgo ni un SLA municipal.

- **Alta:** severidad alta, fuego activo reportado u observado, bloqueo total del paso o afectación confirmada por la evidencia a una rampa/recorrido accesible. Los peligros activos se destacan para revisión urgente aunque la evidencia sea incierta.
- **Media:** severidad media, o incidente de prioridad baja con más de 48 horas abierto.
- **Baja:** severidad baja, sin agravantes identificados.
- **Revisión requerida (eje separado de prioridad):** aplicabilidad, severidad o evidencia contradictoria sin resolver. Un incidente puede ser de prioridad alta y requerir revisión simultáneamente.

La cantidad de reportes forma parte de la evaluación del incidente. Cada nueva asociación dispara una reevaluación con evidencia acumulada, volumen, diversidad aproximada de fuentes, evolución temporal y contradicciones. La IA puede corregir el tipo, aumentar o reducir la severidad y señalar agravamiento, explicando qué evidencia motivó el cambio. La clasificación individual del reporte y la evaluación agregada del incidente se conservan por separado.

La cantidad de fuentes distintas estimadas suma prioridad de atención con rendimientos decrecientes y un tope. El riesgo/impacto determina la banda de prioridad; dentro de esa banda, combinar antigüedad y corroboración. Esto reemplaza la regla preliminar de promoción automática de baja a media por tres reportes. La severidad física solo cambia si hay nueva evidencia sobre daño, extensión o peligro.

**Regla inicial del planificador:** ordenar primero por peligro activo y banda de prioridad; dentro de cada banda, usar `horas_de_espera + bonus_por_corroboracion`, de mayor a menor. Calcular el bonus como `min(tope_horas, peso_horas × log2(max(1, fuentes_distintas_en_ventana)))`. Valores iniciales propuestos para seed: ventana de 24 horas, peso de 2 horas y tope de 12 horas. Son parámetros de prueba configurables por territorio, sin garantía de optimalidad. La espera crece sin tope, mientras el aporte de volumen se satura, para que un incidente menos reportado no quede eternamente postergado dentro de su banda.

Ejemplo con igual prioridad: un incidente con 4 fuentes y 3 horas de espera obtiene 7 puntos equivalentes de espera; uno con una fuente y 6 horas obtiene 6. El primero puede adelantarse. Un incendio con una sola notificación mantiene precedencia sobre basura con cien; el volumen no supera las bandas de riesgo ni habilita despacho cuando falta revisión.

Contar por separado mensajes totales, fuentes distintas estimadas y evidencia repetida. Cada fuente aporta como máximo una vez por incidente y ventana; reintentos, adjuntos idénticos y contenido generado no suman corroboración independiente. En la web anónima, sesión/dispositivo son aproximaciones y no personas verificadas: presentar la métrica como «fuentes estimadas». El backend calcula conteos y bonus; Jev evalúa evidencia y el LLM explica el resultado. Ventanas, pesos y topes se guardan en políticas versionadas.

Mostrar el desglose en el dashboard: banda por riesgo/impacto, horas de espera, fuentes consideradas y aporte de corroboración. Permitir ordenar la lista por cantidad de reportes sin alterar el plan operativo. Recalcular si se refuta/desasocia evidencia o vence la ventana de corroboración.

El operador puede corregir tipo, prioridad, ubicación y estado. Se conserva el resultado original de IA y la corrección manual. Las correcciones son overrides explícitos por campo: una reevaluación no las sobrescribe; retirarlas requiere una acción del operador. Cada evaluación referencia la revisión de evidencia y política utilizada; los resultados obsoletos se descartan y reencolan.

Recalcular factores temporales al consultar y antes de asignar: antigüedad, ventana de corroboración y vigencia de posición. No depender de que llegue otro reporte.

### Validación de Jev — máximo 45 minutos

Probar el mismo esquema con Jev y credenciales del equipo: al menos un caso por categoría inicial, además de texto sin foto, foto ambigua, mensaje basura, ubicación ausente y contradicción. Incluir expresamente contenedor quemado sin fuego frente a contenedor con fuego activo. Evaluar estructura válida, utilidad de la clasificación, tiempo de respuesta y facilidad de integración.

Implementar una función `evaluateReport` que devuelva el esquema interno validado. Un formato inválido o un error produce revisión/reintento, nunca un reporte descartado en silencio. Registrar proveedor, modelo y versión de instrucciones. No construir un sistema de comparación de modelos durante la hackatón.

## 5. Ubicación y barrios

Modelar `Territory` (territorio habilitado, cobertura, centro de mapa y configuración) y `Area` (subdivisión con nombre, geometría y territorio). «Barrio» es la etiqueta configurada para Montevideo; otros territorios pueden usar otra división. La importación del GeoJSON recibe el mapeo de propiedades como configuración. `barrio` y `ogc_fid` son propiedades de esta fuente, no convenciones globales del sistema.

Cada incidente, cuadrilla y política queda vinculado a un territorio. Las búsquedas de cuadrillas y duplicados respetan ese vínculo. La ubicación confirmada determina la cobertura; ninguna condición de negocio debe depender de comparar el nombre con «Montevideo». Habilitar otro territorio requiere importar su cobertura y, si existen, sus subdivisiones, configurar tipos/políticas y cargar recursos. La falta de subdivisiones no impide operar dentro de una cobertura definida.

- Guardar coordenadas confirmadas y texto de ubicación; usar longitud/latitud en GeoJSON.
- Resolver barrio mediante punto dentro de polígono, incluyendo geometrías MultiPolygon.
- Fuente descargada y revisada: EPSG:4326, nombre en `properties.barrio`, identificador en `properties.ogc_fid`.
- Si no se obtiene coincidencia, mostrar «Barrio sin determinar»; no asignar el barrio más cercano automáticamente.
- Usar la copia local para que la demo no dependa de la disponibilidad del WFS.

**Archivo disponible:** [barrios-montevideo.geojson](./barrios-montevideo.geojson), descargado el 17 de octubre de 2026 desde [IDE Uruguay — WFS barrios de Montevideo](https://mapas.ide.uy/geoserver-vectorial/ws_capa_base/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=ws_capa_base%3Abarrios_montevideo&outputFormat=application%2Fjson&srsName=EPSG%3A4326). Contiene 62 features, todas MultiPolygon, con 62 identificadores únicos. Se verificó estructura, propiedades y orden de coordenadas de muestra; queda probar la asignación espacial con puntos conocidos al implementar.

## 6. Reportes duplicados

Un **reporte** es un mensaje ciudadano con su evidencia. Un **incidente** es el problema que se gestiona y puede reunir varios reportes.

La agrupación automática con IA es parte del MVP. Primero recuperar incidentes abiertos del territorio dentro del radio configurado: seed inicial de 30 metros. No excluir problemas persistentes por falta de actividad reciente. La antigüedad y las ventanas temporales por tipo son señales para comparar eventos transitorios. Un evento nuevo posterior al cierre crea una recurrencia vinculada y no reabre automáticamente el incidente anterior. Usar tipo y relaciones entre categorías como señales, sin excluir un candidato solo porque una clasificación inicial sea distinta.

La IA compara el reporte con los candidatos utilizando ubicación, fecha, descripción, evidencia visual disponible y condición del problema. Devuelve `same_incident`, `different_incident` o `uncertain`, candidato elegido, evidencia y contradicciones. Si existe un único candidato con coincidencia suficiente y sin contradicciones materiales, asociar automáticamente sin intervención del operador. La proximidad sola no habilita la unión.

La política de agrupación se persiste y versiona. Si el proveedor dispone de una puntuación documentada para esta decisión, usar un umbral propio (seed inicial 0,90), independiente del umbral de despacho. Sin esa puntuación, exigir decisión estructurada de coincidencia, acuerdo espacial/temporal y evidencia que identifique el mismo objeto o evento; los casos sin evidencia suficiente van a revisión. Evaluar esta regla con pares conocidos, incluyendo dos baches diferentes cercanos.

Si todos los candidatos son distintos, crear un incidente. Si hay varios candidatos plausibles o una comparación incierta, conservar el reporte pendiente y mostrar «Posible duplicado» para revisión. No fusionar automáticamente dos incidentes existentes que ya tengan órdenes activas. Guardar cada decisión con origen automático/manual, modelo, versión y motivo; permitir desasociar y corregir.

Después de asociar o desasociar, recalcular conteos y reevaluar el incidente. Serializar la creación/asociación por zona candidata y volver a comprobar antes de guardar para evitar que reportes simultáneos creen dos incidentes del mismo evento. Una nueva evaluación nunca elimina evidencia anterior ni duplica órdenes; si cambia la capacidad necesaria para una orden activa, marcarla para revisión.

Un candidato a duplicado pendiente de revisión bloquea un nuevo despacho automático. Si se asocia a un incidente ya asignado, agrega evidencia a la orden existente sin emitir otra.

### Unidades de respuesta y asignación automática

La entidad del producto es `ResponseUnit` (unidad de respuesta): puede representar una cuadrilla móvil, una dependencia municipal, una empresa contratista o un servicio especializado. Su tipo y etiqueta se configuran mediante datos. `Crew` se reemplaza por `ResponseUnit` y `crewId` por `responseUnitId`; las referencias a «cuadrilla» que siguen describen únicamente la configuración del piloto.

Cada unidad tiene territorio/cobertura, capacidades, disponibilidad, capacidad de órdenes y destino de entrega. Posición, vigencia de posición y radio son opcionales: una oficina responsable no necesita coordenadas de movimiento. `Assignment` vincula un incidente con una unidad, sin asumir su estructura organizativa.

La política del territorio/tipo elige entre **recurso móvil más cercano**, **responsable de zona** o **revisión manual**. En la primera se requieren ubicación reciente y distancia; en la segunda se consulta la responsabilidad persistida por área y tipo. Si hay varios responsables sin precedencia configurada, pasar a revisión. No aplicar distancia a instituciones sin ubicación operativa ni asumir que en todos los países atiende una cuadrilla.

El MVP implementa las dos reglas sencillas de selección y una bandeja web común; la demo principal usa cuadrillas móviles. Una prueba con una dependencia responsable de zona valida la generalización. Las integraciones con sistemas institucionales externos quedan para después. Para unidades móviles, la seed configura una orden activa; otras unidades pueden tener capacidad mayor configurada. Reserva y liberación respetan esa capacidad en transacciones, en lugar de imponer un límite universal de una orden por unidad.

Al desasociar, el reporte pasa a otro incidente o a revisión pendiente de asociación. Si el original queda vacío, archivarlo y cancelar su orden activa en la misma transacción. Si cambia la compatibilidad de una orden, bloquear inicio/completado hasta revisión. Si el operador resuelve manualmente, completar o cancelar explícitamente la orden activa y liberar capacidad en la misma transacción.

### Configuración de cuadrillas móviles para el piloto

La preparación de demo renueva posiciones simuladas y su fecha mediante una acción explícita auditada, independiente de la seed. Cada transición de orden verifica la unidad autorizada desde la sesión del servidor, nunca confiando en un identificador recibido del cliente.

**Alcance:** tres cuadrillas de demostración creadas por seed y almacenadas en base de datos, con ubicaciones editables. La lógica admite cualquier cantidad de equipos y consulta su estado persistido. Una pantalla móvil sencilla por cuadrilla muestra sus órdenes y permite aceptar, rechazar, iniciar y finalizar el trabajo. La entrega es una orden persistida en su bandeja web, visible mediante actualización periódica. No requiere un número telefónico.

**Configuración de `ResponseUnit` para una cuadrilla móvil:** `id`, `territoryId`, `name`, `capabilities` (relación con tipos/capacidades persistidos), `latitude`, `longitude`, `locationUpdatedAt`, `status` (disponible/reservada/ocupada/fuera de servicio) y `serviceRadiusMeters`. Para el MVP, cada cuadrilla admite una sola orden activa. Las coordenadas de demo se identifican como simuladas. Crear o modificar un equipo en la base debe afectar al despacho sin recompilar ni cambiar código.

**Modelo `Assignment` (orden):** `id`, `incidentId`, `responseUnitId`, `status` (ofrecida/aceptada/en curso/completada/rechazada/cancelada), `createdAt`, `acceptedAt`, `completedAt`, `distanceMeters`, resumen de la evidencia y motivo de selección, versión de la política y evaluación utilizada. Entrega a la bandeja y aceptación son eventos distintos.

**Condiciones para automatizar:**

1. Reporte confirmado por el ciudadano, aplicable y de tipo admitido, con análisis validado.
2. Ubicación confirmada dentro de la cobertura, severidad determinada, sin contradicciones ni revisión pendiente.
3. Sin candidato duplicado pendiente y sin orden activa para ese incidente.
4. Confianza suficiente en aplicabilidad y tipo. Como punto de partida de demo, exigir ambas puntuaciones ≥ 0,90 si el proveedor entrega puntuaciones documentadas en esa escala. Es un umbral experimental que se contrasta con los ejemplos, no una precisión garantizada del 90 %. Si no existe una puntuación adecuada, el operador valida el incidente y habilita su asignación; no se inventa un porcentaje. Jev documenta este mecanismo para Choice; en la primera hora debe probarse con nuestros datos. Exigir además que la elección sea favorable: confianza alta en «no relacionado» nunca habilita despacho.
5. Al menos una cuadrilla del territorio disponible, con capacidad compatible, ubicación reciente y dentro de su radio de servicio. Un peligro activo requiere la habilitación especializada definida por la política del tipo; una coincidencia genérica no alcanza.

**Selección:** el planificador considera la cola completa y filtra unidades elegibles. Conserva capacidad especializada escasa cuando existe otra alternativa adecuada y luego favorece cercanía para unidades móviles. Radio inicial de demo: 3 km; ubicación vigente: actualizada hace menos de 30 minutos. Son parámetros configurables. Mostrar «distancia aproximada»; no presentarla como tiempo de viaje. Las unidades responsables de zona se eligen por responsabilidad/capacidad, sin exigir GPS.

**Entrega:** crear la orden y reservar la cuadrilla en una operación atómica. La bandeja recibe tipo, prioridad y motivo, dirección, barrio, coordenadas, descripción y fotos del incidente. Al aceptar, la cuadrilla pasa a ocupada. Al completar, se resuelve el incidente y queda disponible. Rechazar o cancelar libera la cuadrilla y devuelve el incidente a revisión manual; no generar un ciclo de reenvíos automáticos.

**Sin candidato:** mantener «Pendiente de cuadrilla», con el motivo visible: sin equipo compatible, fuera de radio, ocupado o ubicación desactualizada. Un botón permite volver a evaluar disponibilidad. El operador puede cancelar y reasignar una orden.

**Consistencia:** una orden activa por incidente; cada unidad admite su capacidad configurada, reservada atómicamente. Las cuadrillas de demo tienen capacidad uno, sin imponer ese límite a todas las dependencias. Los reintentos no deben crear otra orden. Si se corrige tipo o ubicación con una orden activa, exigir revisión de esa asignación y registrar el cambio.

La gravedad define el orden de atención; la confianza habilita automatización. Un incidente de gravedad alta y confianza baja queda destacado para revisión. Un caso de gravedad baja y confianza alta puede asignarse si existe capacidad disponible.

### Planificador operativo — qué atender primero

**Objetivo:** entregar a la intendencia u organización una cola de trabajo justificada y asignaciones compatibles con sus recursos. La IA aporta evaluación e impacto; un algoritmo determinista combina esas señales con reglas de servicio, antigüedad y disponibilidad.

El MVP usa una heurística de planificación por lotes, explicable y reproducible. No promete una solución global óptima ni un cronograma horario: todavía no contamos con tiempos de reparación ni viajes por calles. La planificación produce un orden de atención y una propuesta para la capacidad disponible en este momento.

1. **Ordenar la demanda:** peligro activo primero; luego prioridad efectiva; dentro de cada nivel, mayor puntuación de espera más bonus acotado de corroboración, luego antigüedad e identificador estable. Las promociones por espera se aplican antes según las políticas definidas; el volumen no cambia por sí solo la banda de riesgo. Casos que requieren revisión aparecen en una cola destacada con ese mismo orden, pero no se despachan hasta ser elegibles.
2. **Construir compatibilidades:** para cada incidente elegible, calcular unidades habilitadas por territorio, especialidad, zona/radio, vigencia de ubicación y capacidad libre. Las órdenes activas ya consumen capacidad.
3. **Asignar en orden:** para cada incidente, elegir entre sus candidatas preservando recursos que sean la única alternativa para otros incidentes pendientes. Entre opciones con igual costo de oportunidad, elegir la más cercana si son móviles; aplicar precedencia de responsabilidad y carga si son responsables de zona. Desempatar de forma estable. Descontar la capacidad propuesta antes de avanzar al siguiente incidente.
4. **Explicar lo pendiente:** mostrar falta de especialidad, capacidad ocupada, ubicación vencida, revisión pendiente o fuera de radio. Un incidente urgente sin recursos no desaparece detrás de tareas menores.
5. **Publicar y ejecutar:** guardar una versión del plan. Las propuestas automáticas elegibles se convierten en órdenes mediante las validaciones transaccionales de despacho. Una propuesta todavía no es una orden enviada; la UI distingue ambos estados.

Ejemplo: una unidad atiende basura y baches; otra solo basura. Hay un reporte de basura y un bache de igual prioridad. El planificador puede enviar la unidad de limpieza al primero y conservar la polivalente para el bache, aunque esta sea ligeramente más cercana al contenedor. Esto permite atender ambos con la capacidad disponible. Un incidente de prioridad superior mantiene precedencia aunque obligue a usar el recurso escaso.

Replanificar cuando cambia la evidencia/prioridad, se confirma un incidente, cambia disponibilidad o posición, o termina una orden; también con el botón «Actualizar plan» y un intervalo configurable ejecutado por el worker para reflejar antigüedad. Agrupar disparadores próximos para no recalcular por cada evento redundante. Una corrección manual explícita de la asignación prevalece y se registra.

Las órdenes ya ofrecidas, aceptadas o en curso se mantienen y consumen capacidad; no se reenvían ni se cambian silenciosamente al recalcular. Si una orden resulta incompatible, pasa a revisión como ya se define arriba. Un rechazo no provoca un nuevo envío automático: el incidente conserva su bloqueo de revisión hasta resolución del operador.

**Vista «Plan de atención»:** orden recomendado, incidente, prioridad y motivo, antigüedad, unidad propuesta/asignada, razón de selección y bloqueo si existe. Mostrar última actualización y versión; filtros de visualización no cambian el universo que planifica el backend. El operador puede corregir prioridad o reasignar con motivo. La explicación puede redactarla el LLM desde las razones estructuradas del algoritmo.

**Evolución posterior:** incorporar duración estimada por tipo, turnos, materiales, presupuesto, ventanas de atención y tiempos de viaje reales; evaluar asignación de costo mínimo y optimización de rutas con varios trabajos. Comparar contra la heurística del MVP usando incidentes atendidos, espera por prioridad y desplazamiento. Elegir un solver solo cuando existan datos y restricciones que justifiquen ese paso.

## 7. Dashboard accesible

La vista inicial responde «¿Qué requiere atención y dónde está?» con una lista legible. El mapa es una vista complementaria; toda tarea esencial debe poder completarse desde la lista.

**Pantalla principal:** contadores simples de pendientes, por revisar y resueltos; buscador por calle o código; filtros por barrio, tipo, prioridad y estado; orden por prioridad, antigüedad y cantidad de reportes. Por defecto, mostrar abiertos según el orden del planificador, con desglose de espera y corroboración. Un botón visible limpia todos los filtros.

**Evaluación acumulada:** mostrar reportes totales, fuentes distintas estimadas, evidencia repetida y cambios de clasificación, severidad o prioridad con sus motivos. Identificar las asociaciones automáticas y permitir corregirlas.

**Cada fila o tarjeta:** problema en lenguaje cotidiano, barrio/calle, prioridad escrita, antigüedad, estado y número de reportes. Los pendientes de ubicación aparecen en una bandeja, aunque no puedan mostrarse en el mapa.

**Detalle:** foto, descripción, mapa pequeño, evaluación de IA con su evidencia, reportes asociados e historial. Acciones claras: «Corregir datos», «Asociar a incidente», «Marcar en atención» y «Marcar resuelto».

**Asignación:** mostrar cuadrilla, estado de la orden, distancia aproximada y explicación de por qué se asignó o quedó pendiente. Agregar filtro «Sin asignar / Con orden / En curso» y una vista simple de disponibilidad de cuadrillas. La bandeja móvil de cada cuadrilla usa tarjetas y botones grandes; no necesita el dashboard completo. Las sesiones de demo se preconfiguran sin construir administración de usuarios.

**Criterios de accesibilidad:** controles táctiles de al menos 44 × 44 px, texto base de 16 px o mayor, etiquetas visibles, contraste WCAG AA, foco de teclado visible y mensajes de error junto al campo. Colores acompañados por texto e iconos. Evitar acciones que dependan solo de arrastrar el mapa. Anunciar el resultado del envío y los errores a lectores de pantalla.

## 8. Arquitectura mínima

Propuesta técnica: [ARQUITECTURA-RADAR-URBANO.md](./ARQUITECTURA-RADAR-URBANO.md). Define contratos, estados, autorización, jobs persistidos y concurrencia; el stack recomendado se detalla allí y resta provisionar los servicios.

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

Stack recomendado: Next.js/TypeScript, PostgreSQL, Leaflet/Turf, SDK de Jev y adaptador LLM mediante OpenAI Responses API. Railway ejecuta web y worker; Supabase aporta base, Auth y Storage privado. El proveedor de geocodificación/mapas base sigue pendiente. No se han desplegado recursos ni ejecutado llamadas autenticadas.

El backend guarda primero el reporte y registra el estado del análisis. Para esta escala alcanza un procesamiento simple y reintentos manuales, sin introducir infraestructura compleja. El dashboard puede actualizarse por polling o un botón de actualizar.

### Entidades mínimas

- `Territory` y `Area`: cobertura y subdivisiones importadas, etiquetas y configuración geográfica.
- `ProblemType` y capacidades asociadas: catálogo, criterios de evaluación, condiciones de atención y habilitación por territorio.
- `DispatchPolicy`: configuración versionada por territorio/tipo, incluyendo confianza, radios, vigencia de ubicación y tratamiento de peligros activos.
- `PlanningPolicy`, `PlanRun` y `PlanItem`: reglas de orden/selección, instantánea versionada de demanda y capacidad, propuestas y motivos/bloqueos.
- `GroupingPolicy` y `GroupingDecision`: reglas persistidas, decisión de asociación, evidencia, modelo y versión.
- `IncidentAssessment`: evaluación agregada versionada con reportes considerados, tipo, severidad, corroboración, prioridad y motivos de cambios.
- `Report`: identificador, canal, identificador externo opcional, sesión, texto, fotos, fecha, coordenadas confirmadas, estado del análisis y evaluación de IA.
- `Incident`: territorio, área opcional, tipo del catálogo, condición, resumen, ubicación, severidad, prioridad y motivo, estado, fechas de creación/resolución.
- `ReportIncident`: asociación entre reporte e incidente.
- `Event`: correcciones, asociaciones y cambios de estado, con fecha y origen.
- `ResponseUnit`: tipo configurable, territorio/cobertura, capacidades, disponibilidad, capacidad de órdenes, destino de entrega y ubicación opcional. Las cuadrillas son un tipo de unidad.
- `AreaResponsibility`: vínculo persistido entre área, tipo de problema y unidad responsable, con precedencia cuando corresponda.
- `Assignment`: orden vinculada al incidente y a `responseUnitId`, estado e historial de entrega/aceptación.

La entrada común admite `channel`, `externalMessageId`, `sessionId`, `text` y `attachments`. Usar identificadores idempotentes para que un reintento no cree reportes repetidos. Los datos específicos del canal se resuelven en su adaptador.

Guardar claves de IA solo en el servidor; limitar tamaño y tipo de archivos. El dashboard del operador debe tener acceso protegido. Los teléfonos que se incorporen con WhatsApp/SMS no se muestran públicamente.

## 9. Trabajo futuro y evolución del producto

La siguiente etapa busca validar que reportar resulte fácil y que los incidentes lleguen a responsables que puedan resolverlos. El orden propuesto depende de lo aprendido en el piloto. Estos pasos son trabajo futuro, no funcionalidades entregadas ni compromisos con fechas. No forman parte de las 15 horas ni de los criterios de terminado del MVP.

### Etapa 1 — acceso y seguimiento ciudadano

**Objetivo:** reducir el esfuerzo para reportar y cerrar el circuito de comunicación.

| Iniciativa | Valor y alcance | Dependencia / validación |
| --- | --- | --- |
| WhatsApp | Reportar por un canal habitual en Uruguay usando texto, fotos y ubicación; reutilizar evaluación, agrupación y asignación existentes | Conseguir número/proveedor habilitado, validar recepción y reglas de respuestas/seguimiento; medir finalización y tiempo para reportar |
| SMS | Permitir reportes con texto y dirección sin datos móviles; ofrecer enlace opcional para fotos | Verificar cobertura, costo y entrega; no asumir que SMS transporta imágenes; medir reportes completados solo con texto |
| QR contextual | Acceder desde contenedores, paradas, carteles o espacios públicos con activo/ubicación sugeridos; el ciudadano confirma el lugar | Acuerdo para colocación, registro persistido de activos y enlaces; comparar finalización y correcciones de ubicación frente al enlace genérico |
| Seguimiento por el canal elegido | Confirmaciones y avisos de aceptación, atención y resolución, con opción de dejar de recibirlos | Estados confiables, preferencias del ciudadano y reglas de cada proveedor; medir entregas y consultas repetidas por el mismo incidente |
| Audio y accesibilidad ampliada | Recibir notas de voz y extraer descripción/ubicación; mejorar uso con lectores de pantalla y distintos niveles de alfabetización digital | Pruebas con usuarios y confirmación de transcripción; medir errores y abandono por modalidad |

El QR es un mecanismo de distribución y contexto; se incorpora cuando existe un lugar útil donde colocarlo. No requiere desarrollo ni demostración en el MVP. Un QR genérico hacia la web tampoco constituye por sí solo una nueva capacidad de IA.

**Criterio para avanzar:** probar el recorrido con ciudadanos reales y demostrar que pueden completar un reporte útil sin ayuda. Incorporar primero el canal que reduzca más fricción en el territorio del piloto.

### Etapa 2 — operación con una organización real

**Objetivo:** convertir las órdenes de la demo en trabajo integrado con un municipio, contratista u otra organización responsable.

- **Integración institucional:** conectar órdenes y estados con el sistema que ya utilice la organización, usando identificadores externos, reintentos y conciliación. Definir quién acepta, ejecuta y verifica cada tipo de incidente.
- **Administración operativa:** gestionar unidades de respuesta, coberturas, capacidades, horarios, capacidad de trabajo y políticas desde una interfaz. Mantener auditoría y permisos por responsabilidad. Las seeds quedan como mecanismo de inicialización y demo.
- **Disponibilidad y desplazamientos:** actualizar posiciones cuando corresponda, respetar turnos y usar tiempos de viaje por calles para seleccionar recursos móviles. Después, evaluar rutas con varios trabajos y restricciones de equipo/materiales.
- **Resolución con evidencia:** recibir fotos antes/después, usar IA para detectar si apoyan la resolución y permitir confirmación o reapertura por el responsable y el ciudadano. Validar calidad antes de permitir cierres automáticos.
- **Tiempos de atención:** definir objetivos por territorio/tipo, mostrar vencimientos y escalar órdenes sin aceptación. Separar falta de capacidad, fallo de entrega y retraso de ejecución.

**Dependencias:** una organización que participe, responsables identificados, acceso a sus procesos y datos, y acuerdo sobre qué automatizaciones acepta.

**Criterio para avanzar:** completar casos reales desde recepción hasta resolución y medir tiempo hasta aceptación, tiempo hasta resolución, reasignaciones y reaperturas. No atribuir una mejora al producto sin comparar con una línea de base.

### Etapa 3 — calidad de IA y expansión territorial

**Objetivo:** repetir el piloto en otro territorio manteniendo decisiones verificables.

- **Evaluación por categoría:** construir un conjunto revisado de reportes, pares del mismo/distinto incidente y resoluciones. Medir errores de clasificación, fusiones incorrectas, incidentes duplicados y correcciones del operador.
- **Calibración de automatización:** ajustar umbrales y reglas por categoría con esos resultados. Medir especialmente falsos agrupamientos y asignaciones incompatibles; ampliar automatización solo donde la evidencia lo permita.
- **Mejora a partir de correcciones:** usar decisiones revisadas para mejorar criterios, instrucciones o modelos mediante versiones evaluadas. No convertir cada corrección aislada en una regla automática.
- **Nuevo territorio:** importar cobertura y subdivisiones, configurar catálogo, responsables, idiomas, canales y políticas locales; ejecutar las mismas pruebas de aceptación. Validar la generalización con una segunda organización, además de la prueba de configuración del MVP.
- **Control de abuso y privacidad:** mejorar estimación de fuentes independientes, detección de reportes coordinados y manejo de datos personales; separar métricas públicas de información operativa e imágenes sensibles.

#### Reputación de la fuente e historial de reportes

**Objetivo:** reducir ruido recurrente y aportar a Jev u otro evaluador una señal adicional sobre la confiabilidad del reporte actual. Esta función pertenece al trabajo futuro; depende de canales con identificación estable y de reportes cuyo resultado haya sido verificado.

En WhatsApp/SMS, vincular los reportes a una identidad de canal basada en el número normalizado y su ámbito de proveedor. Un número identifica una fuente de contacto, no garantiza una persona: puede ser compartido o cambiar de titular. En la web anónima, una sesión no equivale a un teléfono verificado; no fusionar identidades entre canales sin verificación explícita.

**Modelo propuesto:** `ReporterIdentity` representa la fuente; `ReportVerification` registra para cada reporte el resultado, evidencia, fecha y responsable de verificación. Calcular un resumen versionado `ReporterReputation` a partir de ese historial, con política configurable y trazabilidad.

| Resultado del reporte | Interpretación para reputación |
| --- | --- |
| Confirmado | Existencia del problema corroborada por inspección, evidencia revisada u otra fuente verificable |
| Refutado | Evidencia revisada que contradice el problema reportado; requiere motivo registrado |
| Sin verificar / inconcluso | No aporta evidencia positiva ni negativa sobre la fuente |
| Duplicado | Puede corroborar un problema real; no es falso ni genera crédito repetido por el mismo evento |
| Fuera de cobertura / categoría | No permite concluir si el problema era verdadero o falso |
| Resuelto | Describe el estado del incidente; solo cuenta como confirmación si existe evidencia de que el problema reportado existió |

Una clasificación de IA no confirma ni refuta por sí sola un reporte para alimentar reputación: evitar que una sospecha del modelo se convierta en antecedente y luego justifique nuevas sospechas. Las correcciones de verificación recalculan el historial. No encontrar un problema durante una visita tardía puede ser inconcluso, especialmente en incidentes transitorios.

**Input a Jev:** resumen estructurado con cantidad de eventos verificados, confirmados y refutados; resultados inconclusos; ventana temporal y antigüedad; calidad de la verificación; evidencia repetida o abuso detectado; y reputación estimada con tamaño de muestra e incertidumbre. El backend calcula ese resumen. No enviar el teléfono ni datos personales innecesarios al evaluador. Los umbrales, ventanas y pesos se persisten como configuración.

**Uso en la decisión:** combinar el historial con evidencia actual, consistencia del relato, ubicación y corroboración independiente. Guardar por separado confianza basada en evidencia y ajuste por historial, con motivo. Una fuente nueva parte de una posición neutral; pocos reportes no justifican una conclusión fuerte. La reputación modifica confianza o necesidad de revisión, no la gravedad física observada del incidente.

**Respuesta ante errores recurrentes:** reducir el peso de esa fuente como corroboración independiente, pedir información adicional o dirigir sus reportes a revisión. Aplicar límites temporales de envío cuando exista abuso confirmado, con motivo visible y posibilidad de revisión. Una fuente con malos antecedentes puede reportar un problema real: evidencia actual sólida permite tramitarlo y las señales de peligro activo siguen visibles para atención urgente. Evitar descartes silenciosos y bloqueos permanentes automáticos por reputación.

**Criterio para habilitarla:** comparar en un conjunto revisado decisiones con y sin historial, midiendo reducción de ruido, reportes verdaderos enviados incorrectamente a revisión o descartados, y comportamiento con fuentes nuevas o previamente poco confiables. Incorporar mecanismos de rectificación, retención limitada y recuperación de reputación; ampliar automatización únicamente si mejora el resultado frente a evaluar solo la evidencia.

**Criterio para avanzar:** incorporar un segundo territorio mediante datos y configuración, con calidad medida y sin bifurcar la lógica del producto. Registrar costo por reporte y carga de revisión humana para evaluar sostenibilidad.

### Etapa 4 — prevención y planificación urbana

**Objetivo:** aprovechar un historial suficiente de incidentes y resoluciones para orientar mantenimiento.

- Detectar recurrencia por activo, zona y tipo: contenedores que vuelven a desbordarse, luminarias con fallas repetidas o desagües que requieren mantenimiento frecuente.
- Mostrar tendencias y mapas de concentración junto con cobertura de reportes. Una zona con más reportes puede tener mayor participación ciudadana; no asumir que tiene más problemas únicamente por volumen.
- Proponer inspecciones y mantenimiento preventivo con razones verificables, contrastando contra registros operativos y observaciones de campo.
- Explorar predicción de demanda solo cuando existan datos históricos suficientes; comparar con una regla simple antes de afirmar valor predictivo.

**Criterio para avanzar:** validar con una organización que las recomendaciones ayudan a prevenir recurrencia o planificar mejor recursos, usando métricas acordadas antes de la prueba.

### Cómo presentar la evolución al jurado

Reservar el cierre para tres pasos: **llegar por WhatsApp/SMS**, **conectar con responsables reales** y **expandir a otro territorio con calidad medida**. Mostrar QR contextual y prevención como extensiones posteriores si hay tiempo o preguntas. La hoja de ruta explica qué hipótesis valida cada etapa y qué habilita la siguiente; el puntaje dependerá de los criterios del jurado, por lo que la demo funcional mantiene el protagonismo.

Frase propuesta: «Hoy demostramos el circuito de reporte, agrupación y asignación. El siguiente paso es validarlo con una organización real, abrir WhatsApp y SMS para facilitar el acceso y repetir el piloto en otra ciudad mediante configuración».

## 10. Reparto de 15 horas

Tres personas aportan hasta 45 horas-persona, incluyendo integración y presentación. Acordar los contratos al inicio y conectar una versión mínima antes de pulir pantallas.

| Tiempo | Persona A — recepción | Persona B — IA y datos | Persona C — operación |
| --- | --- | --- | --- |
| 0–1 h | Flujo móvil y contrato de entrada | Prueba de IA/confianza, esquema y persistencia | Estructura dashboard, GeoJSON y mapas |
| 1–4 h | Chat guiado, texto/foto, ubicación | Endpoint, almacenamiento, seeds de catálogo/territorio/cuadrillas y evaluación validada | Lista, detalle y mapa consumiendo datos persistidos de seed |
| 4–7 h | Envío real, confirmación y bandeja móvil de unidad | IA de agrupación, reevaluación agregada y prioridad | Barrio, filtros, reglas de selección y datos de unidades |
| 7–10 h | Aceptar/rechazar órdenes, errores y accesibilidad | Idempotencia, concurrencia y trazabilidad de evaluaciones | Planificador, vista de atención y despacho transaccional |
| 10–12 h | Pruebas de punta a punta entre los tres; completar casos críticos y accesibilidad básica | | |
| 12–13 h | Despliegue y verificación en celulares reales; congelar funcionalidades | | |
| 13–15 h | Preparar ejemplos, practicar pitch y reservar tiempo para fallas | | |

**Hitos:** hora 4, crear y listar un reporte real; hora 7, evaluarlo con IA y ubicarlo; hora 10, enviar una orden a una cuadrilla de demo y aceptarla; hora 12, recorrido completo estable.

**Si hay atrasos:** recortar primero animaciones, seguimiento ciudadano dedicado y personalizaciones del mapa. Gestionar datos mediante seeds y herramientas de base de datos en lugar de construir formularios de administración. La prohibición de hardcodear se mantiene incluso bajo presión de tiempo. Conservar recepción web, evaluación real de IA, agrupación automática, reevaluación del incidente, ubicación confirmada, lista filtrable, revisión de excepciones y el recorrido mínimo de orden/aceptación. Estas funciones reemplazan trabajo accesorio en el cronograma; no sumar otros canales durante estas 15 horas.

## 11. Criterios de terminado

- Desde un celular, se puede conversar con el LLM y enviar un reporte sin cuenta ni instalación; el LLM pide datos faltantes y el ciudadano confirma ubicación y envío.
- Resúmenes y explicaciones reflejan evidencia/estados persistidos; una falla del LLM permite seguir por campos y mensajes de respaldo, sin perder el borrador.
- La conversación no confirma envíos ni ejecuta órdenes por inferencia; las acciones requieren las validaciones y confirmaciones previstas.
- Un reporte válido con foto se evalúa mediante el proveedor real y aparece en el dashboard.
- Un reporte solo con texto también se procesa; la ausencia de foto queda explícita.
- Un mensaje ajeno al servicio no genera un incidente y recibe una orientación útil.
- Una ubicación ausente o ambigua se solicita; nunca se inventan coordenadas.
- Una coordenada conocida recibe el barrio correcto usando el GeoJSON incorporado.
- El operador filtra por barrio, tipo, prioridad y estado, y cambia el orden.
- Dos reportes candidatos pueden asociarse a un incidente y desasociarse.
- Dos reportes con evidencia suficiente del mismo evento se agrupan automáticamente; dos problemas distintos cercanos permanecen separados y los ambiguos pasan a revisión.
- Un nuevo reporte puede actualizar clasificación/severidad con evidencia explicada; corroboración suficiente actualiza prioridad según la política persistida, sin contar reintentos como fuentes nuevas.
- El operador puede revertir una agrupación y ver reevaluados los incidentes afectados.
- Una dependencia sin GPS recibe incidentes por responsabilidad de zona; una cuadrilla móvil se selecciona por cercanía. Ambas usan `ResponseUnit` y la misma bandeja.
- El operador puede corregir una evaluación y marcar un incidente como resuelto.
- Ante un error de IA, el reporte persiste y se puede reintentar sin duplicarlo.
- El flujo principal funciona con teclado y la información de prioridad se entiende sin colores.
- El planificador respeta prioridad, especialidad y capacidad; la cercanía desempata después de considerar recursos escasos y crea una sola orden por incidente.
- En el caso de una unidad polivalente y otra de limpieza, el plan permite atender basura y bache cuando existe capacidad compatible para ambos.
- Replanificar conserva órdenes activas, muestra urgentes sin recursos y no reactiva rechazos pendientes de revisión.
- Más fuentes independientes pueden adelantar un incidente dentro de su banda; el bonus tiene tope, no cuenta reintentos y nunca coloca un caso leve por encima de un peligro activo.
- La cuadrilla ve los datos en su bandeja, acepta y completa la orden; el operador ve cada transición.
- Un incidente con baja confianza o posible duplicado no dispara una orden automática.
- Una cuadrilla ocupada, incompatible o con ubicación desactualizada no se selecciona; si no hay candidatas, el incidente queda pendiente.
- Dos intentos concurrentes no asignan una cuadrilla a dos incidentes ni duplican una orden.
- Las seeds se pueden reejecutar sin duplicar equipos ni sobrescribir su estado operativo; una base vacía muestra un estado vacío real.
- Agregar una cuadrilla o cambiar sus capacidades en la base modifica las candidatas sin cambios de código.
- Catálogo, filtros y opciones de IA se generan a partir de los mismos tipos persistidos.
- Una prueba de configuración con un segundo territorio verifica que cobertura, áreas y selección de equipos no dependen de Montevideo; la demo pública sigue limitada al territorio habilitado.
- Contenedor quemado y fuego activo se clasifican de forma diferenciada; fuego activo nunca se despacha a un equipo sin la capacidad especializada.

Verificar estos recorridos con casos preparados y fotos que el equipo pueda usar. Medir latencia observada durante las pruebas; no prometer porcentajes de precisión a partir de una muestra pequeña.

## 12. Demo de tres minutos

1. **0:00–0:25:** presentar el problema: reportar debe ser fácil y convertir reportes en trabajo organizado lleva esfuerzo.
2. **0:25–1:10:** abrir la web, subir foto de una rampa bloqueada, confirmar ubicación y enviar.
3. **1:10–1:40:** mostrar el plan de atención, el lugar del incidente en la cola y el motivo de su prioridad.
4. **1:40–2:15:** mostrar la unidad elegida y la razón; abrir su bandeja en otro celular y aceptar la orden.
5. **2:15–2:45:** enviar un segundo reporte, mostrar la agrupación automática y la evaluación agregada actualizada sin doble despacho; contrastar con un caso ambiguo en revisión.
6. **2:45–3:00:** mostrar el estado actualizado y presentar los próximos pasos: acceso por WhatsApp/SMS, integración con responsables reales y expansión territorial.

Preparar incidentes de demostración claramente identificados y una grabación de respaldo. La presentación debe distinguir resultados en vivo, datos precargados y funciones futuras.

## 13. Pendientes concretos para empezar

1. GeoJSON incorporado y estructura revisada; al implementar, probar barrio para coordenadas conocidas.
2. Configurar credenciales de Jev y del LLM; probar fotos, conversación en español, extracción de dirección, aclaraciones y explicaciones fieles al estado real.
3. Provisionar Railway/Supabase para el stack recomendado y asignar A/B/C.
4. Reunir fotos y mensajes de ejemplo para el catálogo ampliado y los casos de descarte/revisión, incluyendo fuego activo frente a daño previo.
5. Cerrar el contrato de entrada y salida para trabajar en paralelo.
6. Crear seeds idempotentes de territorio, áreas importadas, catálogo, políticas y tres cuadrillas ficticias con ubicaciones, capacidades y estados que permitan demostrar selección, incompatibilidad y ausencia de disponibilidad. La aplicación consume exclusivamente los registros persistidos.
