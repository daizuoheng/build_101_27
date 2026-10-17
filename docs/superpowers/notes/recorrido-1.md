# Recorrido 1: conversación → borrador → confirmación → job → evaluación real → incidente

17 oct 2026, local (Postgres 18 + PostGIS, `pnpm dev` + `pnpm worker`). Se reproduce con:

```bash
pnpm cli migrate && pnpm cli seed && pnpm cli seed-demo
pnpm dev --port 3100   # terminal 1
pnpm worker            # terminal 2
node --env-file=.env.local scripts/e2e-walkthrough.mjs http://localhost:3100 [foto.jpg]
```

El script usa la API HTTP con cookies, igual que el celular. Jev, DeepSeek y Nominatim son reales; no hay nada simulado.

## Qué se vio

| Paso | Resultado | Latencia |
| --- | --- | --- |
| Crear borrador | Saludo de plantilla `welcome` con el nombre del territorio de la base | — |
| “Bolsas tapando la rampa frente al 1234 de 18 de Julio…” | Jev: `accesibilidad_obstruida`, severidad alta, ubicación precisa → rama `extract_address` → DeepSeek extrae “18 de Julio 1234” → Nominatim propone el punto → pin propuesto | 2,3–5,5 s (Jev ~0,3 s, LLM ~1,2 s, Nominatim ~1 s; más la primera compilación de dev) |
| Foto (bolsas, Commons) | Jev reevalúa la nueva revisión con foto; la foto no muestra una rampa → `low_confidence` | 3,6 s |
| Confirmar el punto | PostGIS: barrio CENTRO; nueva evaluación → rama `ready`, ficha completa, botón habilitado | 1–4 s |
| Enviar dos veces con la misma clave | Mismo código (`5ZBUDR`) y un solo job `process_report` | — |
| Worker | Reutiliza la evaluación de la recepción (misma revisión, catálogo y política) y crea el incidente con banda **alta** (regla `accessibility_affected`) | 30–140 ms |
| `/operacion` (operador logueado) | Incidente visible con título, barrio, prioridad, estado y revisión abierta `low_confidence` en el caso con foto | — |

## Pendiente de este recorrido

- Probar desde un celular real por LAN o despliegue: GPS, cámara y tiles de OSM. La UI responde 200 en las cuatro páginas, pero solo se probó por HTTP.
- Despliegue en Railway y Supabase: a la espera de las cuentas del equipo.
- Nominatim no resuelve esquinas (“Rivera y Comercio”); en ese caso la UI cae al mapa.
