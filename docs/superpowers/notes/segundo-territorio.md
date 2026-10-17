# Segundo territorio: Montevideo es configuración

17 oct 2026. `seeds/territory-demo-b.ts` crea `demo-b`, un territorio sintético que **solo usan los tests**. No entra
en `seedAll`. Tiene:

- un cuadrado de ~1 km en (0°, 0°), con cobertura y un área;
- dos tipos habilitados (`bache`, `basura_acumulada`);
- las políticas del seed con dos diferencias: `grouping.radius_m = 75` y `textgen.enabled = false`;
- una cuadrilla (`cuadrilla-b`).

## Qué prueba `tests/db/second-territory.test.ts`

- Un punto dentro del cuadrado se localiza en `demo-b` (con su área) y no en Montevideo. Plaza Independencia se
  localiza en Montevideo. Un punto fuera de ambos da `null`.
- Las políticas y el catálogo se leen por territorio: radio de agrupación 75 contra 30, `textgen` apagado contra
  prendido, catálogo de 2 tipos con `catalog_hash` distinto. La vista del territorio usa su nombre, su etiqueta de
  área ("Sector") y su zoom.
- La consulta de unidades por territorio devuelve solo `cuadrilla-b`, aunque una cuadrilla de Montevideo se mueva
  físicamente dentro de `demo-b`. El filtro es por territorio, no por cercanía.
- Un reporte en `demo-b` recorre recepción → confirmación → worker (`process_report`) y crea el incidente en `demo-b`,
  con su área.
- `seedAll` de producción no crea `demo-b`, y reseedear `demo-b` es idempotente.

**Pendiente**: el plan pide además que "su plan solo considera unidades de demo-b". El snapshot del planificador
(`src/server/pipeline/plan.ts`, sesión A) todavía no existe en `epic/nucleo`. Por ahora el test fija la consulta de
unidades por territorio que ese snapshot tiene que respetar. Cuando entre `runPlan`, conviene agregar el caso:
`runPlan(demo-b)` ⇒ `plan_items` solo con `cuadrilla-b`.

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

Fuera de `src/`: `scripts/cli.ts` (`seed-demo`, `refresh-demo-positions`) y `policy-upgrade` (en la épica de
agrupación) toman `montevideo` como valor por defecto de `--territory`. Es aceptable para comandos de operación,
pero se podría exigir el parámetro.

No hay coordenadas, barrios, umbrales ni catálogos de Montevideo en el código del servidor: todo sale de
`territories`, `areas`, `policy_versions` y `territory_problem_types`.
