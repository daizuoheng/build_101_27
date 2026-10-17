# Reevaluación del incidente con Jev real (T10) — 17 oct, ~21:00

Base de desarrollo limpia (`reset-demo`), servidor y worker locales. Tres reportes reales por HTTP; Jev, DeepSeek y Nominatim de verdad.

## Agrupación: el umbral está en el borde

El mismo par (bolsas sobre la rampa, contado con otras palabras) dio `same_incident` **0,93** en una corrida anterior y **0,89** en esta. Con `same_threshold = 0,90`, esta vez fue a revisión (`uncertain_duplicate`) en lugar de asociarse. Es el comportamiento correcto según la política, pero el umbral queda justo en la variación de Jev (±0,04). Conviene calibrarlo con fotos reales del equipo antes de la demo: bajarlo a 0,85 asociaría este caso, y el par distinto más cercano medido (bache vs basura) dio `same` 0,00.

## Reevaluación

Asociando el reporte a mano (como lo haría el operador al resolver la revisión) se encoló `assess_incident`:

| Pregunta | Respuesta |
| --- | --- |
| Tipo | `accesibilidad_obstruida` 0,97 |
| Severidad | `high` 0,99 |
| Paso | `total` 0,93 |
| Accesibilidad | `affected` 1,00 |
| Fuego activo | `no` 0,99 |
| Evolución | `same` 0,75 |
| Consistencia entre reportes | `consistent` 1,00 |

`jev-1.14.0`, 306 ms. Conteos del backend: 2 reportes, 2 fuentes, 2 en la ventana de 24 h, 0 evidencia repetida. Los valores ya coincidían con los vigentes, así que no hubo cambios ni subió la revisión del incidente.

La política `evaluation` cambió de forma (sección `assessment`): `pnpm cli seed` la publicó sola como v2 sobre la base ya sembrada.
