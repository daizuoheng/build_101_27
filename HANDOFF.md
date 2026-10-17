# Handoff — Radar Urbano

Actualizado: 17 de octubre de 2026. Workspace: `/Users/fededallo/Desktop/hackaton`.

## Estado real

Estamos al final de definición de producto y arquitectura. **No hay aplicación implementada**, dependencias instaladas para ella, migraciones, tests de aplicación ni despliegue. No se ejecutaron llamadas autenticadas a Jev/OpenAI ni se crearon servicios Railway/Supabase. Se investigó documentación oficial, descargó/verificó el GeoJSON y escribieron los documentos.

La hackatón fue planteada para **15 horas y 3 personas**. No asumir que quedan 15 horas desde la nueva sesión; falta conocer el tiempo restante. El equipo no tiene preferencia de stack ni proveedor de infraestructura existente.

Última petición del usuario: preparar este handoff y un prompt para continuar. La implementación es el siguiente trabajo propuesto, no trabajo ya realizado. No afirmar que nada está subido, publicado o probado si no se verifica.

## Archivos que leer, en orden

1. [ALCANCE-RADAR-URBANO.md](./ALCANCE-RADAR-URBANO.md): definición de producto, MVP, roadmap, prioridades, planificador y criterios de terminado.
2. [ARQUITECTURA-RADAR-URBANO.md](./ARQUITECTURA-RADAR-URBANO.md): stack recomendado, contratos, estados, datos, jobs, permisos y concurrencia.
3. [INTEGRACION-JEV.md](./INTEGRACION-JEV.md): capacidades verificadas documentalmente y cómo dividir tareas entre Jev, LLM y backend.
4. [barrios-montevideo.geojson](./barrios-montevideo.geojson): datos geográficos locales para importar, no para hardcodear en componentes.

Estos archivos evolucionaron durante brainstorming. Las decisiones recientes resumidas aquí aclaran posibles formulaciones viejas; sincronizar contradicciones concretas sin reabrir todo el diseño ni recortar requisitos silenciosamente.

## Qué construimos

Sistema que convierte reportes ciudadanos en incidentes evaluados, agrupados y priorizados; propone un plan de atención y emite órdenes a unidades de respuesta compatibles. La IA es central al producto. El chat es una entrada accesible y no agota la experiencia.

El MVP opera en Montevideo. **El producto es generalizable por configuración a otros territorios y organizaciones**. Usar `Territory`, `Area` y `ResponseUnit`; una cuadrilla es un tipo de unidad, no un supuesto universal. Un responsable de zona puede operar sin GPS.

Entrada actual: web móvil por enlace, conversación mediante LLM, foto opcional, ubicación confirmada y envío explícito. Sin instalación ni registro ciudadano. Dashboard accesible con lista, mapa, filtros, detalle y plan de atención; bandeja móvil para unidades.

WhatsApp, SMS y QR contextual quedan en roadmap. También reputación por historial verificado de fuente, audio, integraciones institucionales, rutas optimizadas y mantenimiento predictivo. **No implementar el roadmap en el MVP.**

## Requisitos que no se deben perder

- **Prohibido hardcodear datos operativos:** unidades, coordenadas, categorías, territorios, umbrales, radios, ventanas y criterios se persisten mediante seeds/configuración. Algoritmos, contratos y estados estructurales sí viven en código.
- Seeds idempotentes, sin sobrescribir cambios operativos. Reset de demo y renovación de posiciones simuladas son comandos explícitos separados.
- Catálogo inicial: baches, basura, accesibilidad obstruida, contenedor dañado/quemado sin fuego, contenedor con fuego, vereda rota, cartelería dañada/caída/obstruida, alumbrado, árbol/rama caída y desagüe obstruido.
- Diferenciar fuego activo de daños previos; requiere capacidad especializada y atención destacada.
- Agrupación **automática con IA** cuando existe evidencia suficiente; revisión de casos ambiguos y asociación reversible. No reducirla a un botón manual.
- Conservar evidencia original y evaluar el incidente agregado ante nuevos reportes. Un resumen del LLM no es evidencia independiente.
- Procesamiento, revisión, prioridad y estado operativo son dimensiones distintas. Un caso urgente puede requerir revisión.
- Correcciones humanas por campo prevalecen hasta retirarlas explícitamente; evaluaciones obsoletas se descartan.
- Confirmar el reporte antes de agrupar/despachar. Persistir borrador y turnos antes de llamar modelos.
- Una orden activa por incidente; capacidad configurable por unidad reservada atómicamente. La seed de cuadrillas móviles usa capacidad uno.
- Respetar autorización por sesión/territorio/unidad; el código visible del reporte no concede acceso.

## Prioridad y planificación: decisión más reciente

Más fuentes distintas pueden adelantar la atención, pero cantidad no equivale a gravedad.

Orden del plan: **peligro activo → banda de prioridad → espera + bonus acotado de corroboración → antigüedad → ID estable**.

`puntuación = horas_de_espera + min(tope_horas, peso_horas × log2(max(1, fuentes_distintas_en_ventana)))`

Valores propuestos para seed, pendientes de validar: ventana 24 h, peso 2 h, tope 12 h. El bonus se satura y la espera crece sin tope dentro de la banda. La antigua regla de promover baja a media por tres reportes fue reemplazada. No combinar ambas reglas.

Contar fuentes estimadas, no afirmar personas verificadas en web anónima. Una fuente aporta como máximo una vez por incidente/ventana. Reintentos y evidencia idéntica no suman corroboración independiente. Las promociones por antigüedad siguen siendo una política separada; volumen solo no modifica severidad o banda de riesgo.

El planificador considera todos los incidentes elegibles y capacidad disponible. Preserva unidades que sean la única opción para otros problemas y luego favorece cercanía/precedencia según el tipo de unidad. Es una **heurística**, no un óptimo global ni un itinerario con ETA. Guarda planes versionados y sus razones. Recalcular ante eventos y periódicamente mediante el worker; conservar órdenes activas y bloqueos de revisión. Filtrar la vista no modifica el universo de planificación.

## Arquitectura recomendada

- TypeScript + Next.js, Node.js ≥22, Zod; un repositorio con web/API y worker separado.
- PostgreSQL, `pg` y migraciones SQL. Jobs persistidos, sin Redis ni microservicios adicionales.
- Railway para ambos procesos; Supabase para PostgreSQL, Auth y Storage privado. **Recomendación documentada, todavía no provisionada.**
- Leaflet + Turf para los polígonos del piloto; proveedor de mapas base y geocodificación pendiente.
- Jev mediante `@typesafe-ai/sdk` para decisiones; LLM mediante OpenAI Responses API para conversación y generación de texto. Modelo generativo específico pendiente.
- Propuestas de modelos no ejecutan operaciones directamente: backend valida, aplica políticas y hace transacciones.
- Serialización persistida por territorio a esta escala; nunca mantener una transacción abierta esperando una llamada IA. Revalidar revisiones antes de aplicar resultados.

### División de IA

**LLM:** conversa, propone extracción de dirección/descripción, pide datos faltantes, redacta resúmenes y explicaciones desde información autorizada. Ubicación y envío se confirman explícitamente. No inventa estados, asistencia o tiempos de llegada. Plantillas solo como fallback. El usuario pidió expresamente incorporar este LLM después de que inicialmente se hubiera planteado usar solo Jev.

**Jev:** `evaluateReport`, `compareCandidates`, `assessIncident`. Preguntas tipadas y acotadas; texto libre y explicaciones no son salidas nativas de Jev.

**Backend:** conteos, geocodificación, barrio, prioridad, planificación, permisos, reservas, órdenes e historial.

## Jev: hallazgos documentales que afectan la implementación

- Docs: https://docs.typesafe.ai/introduction y https://docs.typesafe.ai/llms.txt.
- `Choice`/`Score` devuelven probabilidades y confianza; `Noul` devuelve probabilidad de verdadero sin confianza separada. Confianza alta puede corresponder a una respuesta negativa: comprobar respuesta y confianza.
- La confianza no es una garantía del porcentaje de acierto en nuestro dominio. Umbrales por pregunta/acción versionados y probados con ejemplos.
- Preguntas en una llamada son independientes: no dependen de la respuesta de otra pregunta de esa misma llamada.
- Imágenes experimentales: header `TypeSafe-Danger-Zone-Images: true`; PNG/JPEG, 280–1568 px por lado, aplicar orientación antes de enviar. Ver límites completos en INTEGRACION-JEV.md.
- Propuesta inicial de modelo versionado: `jev-1.14.0`, configurable; verificar disponibilidad y comportamiento con credenciales.
- Probar español uruguayo y fotos reales temprano. La documentación respalda la capacidad de API, no la precisión del piloto.
- No se inspeccionaron ni utilizaron secretos. Pedir/configurar credenciales mediante mecanismos seguros cuando se necesiten; nunca incluirlas en documentos o logs.

## GeoJSON

Copia local descargada desde IDE Uruguay. Se verificó JSON, 62 features `MultiPolygon`, IDs únicos y coordenadas en el entorno de Montevideo. Nombre en `properties.barrio`, ID fuente `properties.ogc_fid`, CRS EPSG:4326, orden longitud/latitud.

Falta probar consultas punto-en-polígono con ubicaciones conocidas. La unión de barrios es cobertura de demo, no afirmar que es un límite administrativo completo validado. Importar a base con mapeo configurable. Ya no se necesita el disco externo de rental-scout-lite.

## Revisión por subagente realizada

El usuario autorizó una revisión por subagente. Detectó y se incorporaron: precedencia de overrides, estados independientes, borrador/confirmación, autorización por unidad, problemas abiertos antiguos excluidos por ventana, posiciones de seed vencidas, desasociación del último reporte, capacidad variable y actualización por paso del tiempo.

Reglas importantes: no excluir un bache abierto por siete días de inactividad; recurrencias posteriores a cierre son nuevos incidentes vinculados. Al quedar un incidente sin reportes, archivar y cancelar orden liberando capacidad. Una orden incompatible bloquea inicio/completado hasta revisión. La autorización anterior fue para revisión; no asumir delegación ilimitada para implementación.

## Próximo trabajo recomendado

1. Leer documentos y verificar estado Git/archivos actuales; preservar cambios ajenos.
2. Conocer tiempo restante y coordinar tareas A/B/C. Obtener credenciales y provisionar servicios cuando corresponda; avanzar en trabajo local independiente mientras tanto.
3. Probar Jev con texto/foto y el LLM conversacional; verificar formatos, latencia y manejo de error. No sustituir llamadas reales con respuestas simuladas ocultas.
4. Fijar contratos, estados y esquema; scaffold web/worker, migraciones y seeds.
5. Primer recorrido integrado: conversación → borrador → confirmación → job → Jev → incidente visible.
6. Agrupación y reevaluación → planificador → orden → aceptación en bandeja.
7. Verificar reintentos, conflictos, permisos, overrides, fuentes repetidas, restricciones de capacidad y fallback de generación. Luego pulir accesibilidad y demo.

La implementación aún requiere decidir modelo LLM y proveedor de mapas/geocodificación. No convertir la sesión nueva en otro brainstorming extenso; resolver decisiones técnicas rutinarias dentro del alcance.

## Estado Git observado al preparar este archivo

`ALCANCE-RADAR-URBANO.md` modificado; `ARQUITECTURA-RADAR-URBANO.md` e `INTEGRACION-JEV.md` sin seguimiento. Este handoff y el prompt también son archivos nuevos. No se hizo commit ni push en esta tarea. Volver a consultar Git porque el usuario puede haber subido cambios después.

## Instrucciones de entorno

- Prefijar comandos shell con `rtk`; usar `rtk proxy` cuando haga falta salida sin filtrar.
- Seguir instrucciones AGENTS aplicables y `/Users/fededallo/.codex/RTK.md`.
- Usuario pide codedb primero para navegación de código; anteriormente falló la carga/indexación por permisos. No depender de `codedb.snapshot` como descripción de implementación existente; verificar su salud y usar archivos actuales como fallback.
- Si existe `.codegraph/`, usar CodeGraph antes de buscar/leer código; no crear índice por cuenta propia.
- Revisar skills relevantes cuando se implemente UI o APIs. Se usó OpenAI Docs para investigar la integración generativa, no para ejecutar API.
- No crear recursos externos, enviar mensajes, publicar ni afirmar despliegues como parte de una tarea meramente documental.
