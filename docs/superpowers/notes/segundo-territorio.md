# Segundo territorio: Montevideo es configuración

17 oct 2026. `seeds/territory-demo-b.ts` crea `demo-b`, un territorio sintético que **solo usan los tests**. No entra
en `seedAll`. Tiene:

- un cuadrado de ~1 km en (0°, 0°), con cobertura y un área;
- dos tipos habilitados (`bache`, `basura_acumulada`);
- las políticas del seed con dos diferencias: `grouping.radius_m = 75` y `textgen.enabled = false`;
- una cuadrilla (`cuadrilla-b`), sin fecha de posición como el resto de las unidades de demo
  (`refreshDemoPositions(pool, "demo-b")` la marca vigente).

## Qué prueba `tests/db/second-territory.test.ts`

- Un punto dentro del cuadrado se localiza en `demo-b` (con su área) y no en Montevideo. Plaza Independencia se
  localiza en Montevideo. Un punto fuera de ambos da `null`.
- Las políticas y el catálogo se leen por territorio: radio de agrupación 75 contra 30, `textgen` apagado contra
  prendido, catálogo de 2 tipos con `catalog_hash` distinto. La vista del territorio usa su nombre, su etiqueta de
  área ("Sector") y su zoom.
- Contrato para el planificador: una consulta de unidades filtrada por territorio devuelve solo `cuadrilla-b`, aunque
  una cuadrilla de Montevideo se mueva físicamente dentro de `demo-b`. Es una consulta del test, no de producción
  (todavía no hay código que elija unidades; ver **Pendiente**).
- Un reporte en `demo-b` recorre recepción → confirmación → worker (`process_report`) y crea el incidente en `demo-b`,
  con su área.
- `seedAll` de producción no crea `demo-b`, y reseedear `demo-b` es idempotente.
- Reseedear `demo-b` con otra config publica una versión nueva activa y deja la anterior intacta e inactiva; si no
  queda ninguna activa (p. ej. la v1 desactivada), el reseed publica una. Siempre hay exactamente una activa por kind.
- Reseedear con otro zoom, cuadrado, catálogo, capacidades o posición deja `demo-b` como dice el archivo: el tipo que
  sale del catálogo queda deshabilitado, la capacidad que sale se borra y una posición nueva pierde la fecha de la
  anterior. El evento `demo_seeded` se registra una sola vez, al crear la unidad.

**Pendiente**: el plan pide además que "su plan solo considera unidades de demo-b". El snapshot del planificador
(`src/server/pipeline/plan.ts`, sesión A) todavía no existe en `epic/nucleo`. Por ahora el test fija la consulta de
unidades por territorio que ese snapshot tiene que respetar. Cuando entre `runPlan`, conviene agregar el caso:
`runPlan(demo-b)` ⇒ `plan_items` solo con `cuadrilla-b`.

## El seed de `demo-b` converge al archivo

`seedAll` no pisa lo existente, porque en Montevideo lo puede haber cambiado operación (la única excepción: si la
política activa ya no valida contra el esquema, publica la del seed como versión nueva). `demo-b` no tiene
operación: su única fuente de verdad es `seeds/territory-demo-b.ts`, así que cada corrida deja sus valores como dice
el archivo (el estado de la unidad sí queda fuera, porque los tests lo cambian a propósito). Converge por clave
natural: renombrar el slug de la unidad o el `externalId` del área crea filas nuevas y no borra las viejas, que
pueden estar referenciadas por incidentes u órdenes.

Las políticas se versionan, no se editan: el seed compara la versión activa con la del archivo y, si falta o
difiere, publica la del archivo como `max(version) + 1` activa, igual que `policy-upgrade`. No usa
`on conflict do update set config`: las evaluaciones y decisiones guardan el `policy_version_id` con que se
calcularon, y editar esa fila cambiaría a posteriori lo que dice esa traza.

Ese SQL de publicación hoy está repetido en `seeds/index.ts`, `scripts/policy-upgrade.ts` y este seed. Un helper
compartido (`publishPolicyVersion`) los unificaría, pero toca archivos de otras tareas: queda para después.

## Referencias a Montevideo y al locale en `src/`

Las mismas en `epic/nucleo`, `epic/operacion`, `epic/recepcion` y `nucleo/agrupacion`.

| Dónde | Qué | Severidad | Sugerencia |
|---|---|---|---|
| `src/app/page.tsx:4` | `PILOT_TERRITORY = "montevideo"` | Permitido (enlace de demo) | — |
| `src/app/reportar/_components/ReportApp.tsx:435` | `toLocaleString("es-UY")` | Baja: formato de fecha uruguayo fijo | Usar `territories.locale` (hoy `es`) o una configuración de formato del territorio en la vista |
| `src/app/operacion/_components/IncidentBoard.tsx:64` | `toLocaleTimeString("es-UY")` | Baja: ídem | Ídem |
| `src/server/geo/geocoder.ts:39` | `Accept-Language: "es"` fijo | Baja: un territorio en otro idioma geocodificaría con nombres en español | Pasar `territories.locale` al geocodificador |
| `src/server/config/templates.ts:15` | `locale = "es"` por defecto en `renderTemplate` | Baja: los llamadores no pasan el locale del territorio | Resolver el locale desde `territories.locale` |
| `src/app/layout.tsx:16` | `<html lang="es">` | Aceptable mientras la UI sea solo en español | — |

Fuera de `src/`: `scripts/cli.ts` (`seed-demo`, `refresh-demo-positions`, `policy-upgrade`) y
`scripts/policy-upgrade.ts` toman `montevideo` como valor por defecto de `--territory`. Es aceptable para comandos
de operación, pero se podría exigir el parámetro.

No hay coordenadas, barrios, umbrales ni catálogos de Montevideo en el código del servidor: todo sale de
`territories`, `areas`, `policy_versions` y `territory_problem_types`. Pero los **valores** de `seeds/policies.ts`
sí son de Montevideo, y un territorio nuevo que los reuse los hereda:

- `intake.geocoder.query_suffix = "Montevideo, Uruguay"` y `country_codes = "uy"`: con eso el geocodificador no
  encuentra nada fuera de Uruguay. `demo-b` los reemplaza (prueba en el test del geocodificador).
- Las instrucciones de las preguntas a Jev de `evaluation` y `grouping` dicen "(Spanish, Uruguay)". `demo-b` las
  conserva porque sus tests no llaman a Jev. Un territorio real tiene que reescribirlas en su propia política.
