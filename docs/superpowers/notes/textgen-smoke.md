# Textos generados (T15): smoke real con DeepSeek

17 oct 2026. Comando: `pnpm cli smoke-llm`. Usa el modelo `deepseek-flash` vía `api.deepseek.com` y la política
`textgen-v1` del seed, con `json_object` y `max_output_tokens` 300. Son tres incidentes de ejemplo con nueve textos
(título, resumen y explicación de prioridad), redactados con `draftText`. No se cachea ni se crean incidentes; cada
intento queda en `llm_runs`.

## Resultado

**9/9 textos vinieron del LLM y validaron** contra el esquema, el largo máximo, las referencias del input y los
patrones prohibidos. Ninguno cayó a plantilla. Cada llamada tardó entre 0,8 y 1,6 s; los tres textos de un
incidente, en paralelo, tardan lo que la llamada más lenta.

| Incidente | Propósito | ms | Texto |
|---|---|---|---|
| contenedor-fuego | title | 1417 | Contenedor prendido fuego en CORDON |
| | summary | 1561 | Se reporta un contenedor prendido fuego en 8 de Octubre y Garibaldi, CORDON, con humo negro que llega a las casas. El paso está parcialmente obstruido y el hecho cuenta con 2 reportes. |
| | explain_priority | 1591 | El incidente tiene prioridad alta porque presenta severidad alta y peligro activo. |
| bache | title | 1077 | Bache en LA BLANQUEADA |
| | summary | 1407 | Hay un bache en Av. Italia 2450, LA BLANQUEADA, con paso parcialmente obstruido. Lo respalda 1 reporte. |
| | explain_priority | 1037 | El incidente tiene prioridad media porque se corresponde con una severidad media. |
| rampa-obstruida-antigua | title | 1368 | Accesibilidad obstruida en CENTRO |
| | summary | 1406 | Se reporta accesibilidad obstruida en Rivera y Comercio, CENTRO, con la rampa bloqueada por bolsas de basura según 3 reportes. La severidad es baja, no hay peligro activo y el paso está libre, pero la accesibilidad está afectada. |
| | explain_priority | 1292 | La prioridad es alta porque el incidente afecta la accesibilidad y además presenta antigüedad sin atender. |

Las referencias citadas fueron siempre ids del input: los reportes en título y resumen, y los códigos de motivo
(`severity_high`, `active_hazard`, `accessibility_affected`, `promoted_by_age`…) en la explicación.

## Observaciones

- En la primera corrida el resumen escribió «Córdón» en lugar de «CORDON». Se agregó a `instructions.common` que copie
  nombres de lugares, barrios y tipos tal como vienen; en la segunda corrida (la de la tabla) los copió bien.
- El texto repite los nombres de barrio en mayúsculas porque así vienen del GeoJSON de la IDE. Si se quiere otro
  formato, se arregla en los datos, no en el prompt.
- «El paso está libre, pero la accesibilidad está afectada» (rampa) es fiel a los hechos: `passage = none` y
  `accessibility = affected` son preguntas distintas de Jev.
- Ningún texto mencionó estado, asignación ni tiempos. El rechazo de esas frases (`forbidden_patterns`) está cubierto
  por tests con el doble del LLM.

## Handler con el worker real (base local)

Se publicó la política nueva como `textgen` v2 en `radar_urbano_despliegue`. Después se encoló `textgen` para el
incidente del recorrido y se corrió `pnpm worker`. Resultado: `✓ textgen …@1 1292ms` y tres filas en
`generated_texts` con `llm_run_id`:

- title: «Accesibilidad obstruida en CENTRO»
- summary: «Se reporta accesibilidad obstruida en 18 de Julio 1234, CENTRO: el paso está bloqueado y la accesibilidad afectada. Un reporte lo respalda.»
- explain_priority: «El incidente tiene prioridad alta porque presenta severidad alta, el paso bloqueado y la accesibilidad afectada.»

## Después de la revisión de Tenki (PR #7)

Se repitió `pnpm cli smoke-llm` con los cambios de la revisión: las referencias van delimitadas entre
`<referencias>` y se recortan a `max_reference_chars`, hay una instrucción `untrusted` y los patrones prohibidos
ahora usan límites de palabra Unicode. De nuevo 9/9 textos vinieron del LLM y validaron, entre 0,9 y 1,7 s por
llamada. Diferencias menores de redacción; por ejemplo, un resumen dice «la peligrosidad es alta» por la severidad.

## Para las bases existentes

La política `textgen` tiene campos nuevos: `max_chars`, `max_references`, `max_reference_chars`,
`forbidden_patterns`, `instructions` (con `untrusted`) y `labels`. Una base con la v1 vieja la rechaza al validar
(`PolicyInvalidError`) y el job `textgen` falla. No se le ponen valores por defecto en el código, porque la política
no se hardcodea. Para actualizarla:

```bash
pnpm cli seed                              # inserta las plantillas textgen_* que falten
pnpm cli policy-upgrade --kind textgen     # publica la política del seed como versión nueva activa
```

Una base nueva (Supabase) toma todo del seed.
