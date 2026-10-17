# Textos generados (T15): smoke real con DeepSeek

17 oct 2026. Comando: `pnpm cli smoke-llm`. Usa el modelo `deepseek-flash` vía `api.deepseek.com` y la política
`textgen-v1` del seed, con `json_object` y `max_output_tokens` 300. Son tres incidentes de ejemplo con nueve textos
(título, resumen y explicación de prioridad), redactados con `draftText`. No se cachea ni se crean incidentes. Desde la
revisión interna tampoco escribe `llm_runs`, porque sus ids no son incidentes reales.


> **Decisión del 17 oct: los textos son deterministas.** La política `textgen` del seed trae `llm_purposes: []`, así
> que el título, el resumen y la explicación de prioridad salen de las plantillas `textgen_*`, armadas con los hechos y
> los códigos de motivo del backend. No hay texto libre generado, por lo que no hay riesgo de que se prometa despacho
> ni tiempos. El LLM sigue disponible por propósito (por ejemplo, `["summary"]` para condensar las descripciones de
> los vecinos). Este smoke prueba ese camino forzando los tres propósitos.
>
> Ejemplo real con el worker: título «Accesibilidad obstruida — 18 de Julio 1234, CENTRO»; explicación «Prioridad
> alta por: severidad alta, paso bloqueado, accesibilidad afectada.» (31 ms, sin LLM).

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

## Tras la revisión interna (tres pasadas)

Corrida final con **4 incidentes**: se agregó "basura-antigua-camino", un incidente bajo promovido por antigüedad en
Camino Maldonado 5600, y la rampa quedó con un desglose que `computePriority` puede producir. **12/12 textos
vinieron del LLM y validaron**, entre 0,9 y 1,5 s por llamada.

El smoke encontró dos falsos positivos de los patrones prohibidos, que ya están corregidos y cubiertos por tests:

- «en camino» chocaba con calles de Montevideo (Camino Maldonado, Camino Carrasco). Ahora exige un verbo antes
  («ya está en camino»).
- `asign*` rechazaba «se le asigna prioridad media». Ahora solo cuenta asignar, enviar o mandar con personal como
  objeto, o afirmar un estado («fue asignada»).

El título ya no recibe las descripciones de los reportes: sale solo de tipo y lugar.

## Patrones prohibidos: detector de humo, no garantía

Durante la revisión, la lista de `forbidden_patterns` creció para cubrir cada conjugación, negación y construcción
del español, y cada vuelta encontraba otra. Por decisión del equipo (17 oct) quedó reducida a 5 patrones de alta
precisión, casi sin falsos positivos:

- plazo concreto de llegada o resolución («llegará en 30 minutos», «se resolverá en 24 horas»);
- «en camino» como aviso;
- despacho afirmado con el actor pegado al verbo («se envió una cuadrilla»);
- «despachar».

La garantía no depende de esa lista: los hechos que recibe el LLM nunca traen estado, unidades, despacho ni
tiempos, y las instrucciones lo prohíben. La lista no se amplía salvo que aparezca un caso real en producción.
Si hiciera falta un control semántico, la opción evaluada es una pregunta Noul de Jev sobre el texto antes de
guardarlo.

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

Si se saca un propósito de `llm_purposes` (o se apaga textgen), sus textos del LLM ya guardados se reemplazan
por la plantilla la próxima vez que se pidan para esa revisión. No hay barrido de las revisiones ya procesadas: para
retirarlos de una vez hay que volver a encolar `textgen` o borrar esas filas de `generated_texts`. Hoy no aplica,
porque ninguna base tiene textos del LLM en producción.

El seed nunca pisa plantillas que ya existen. Una base que ya tenía `textgen_summary` conserva la versión vieja
(sin peligro activo, paso ni accesibilidad) hasta que alguien la actualice a mano desde `seeds/templates.ts`.
