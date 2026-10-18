# Demo en vivo — preparación y verificación

Guion: (1) un ciudadano conversa con el agente en `/reportar/montevideo` y envía el reporte; (2) la consola de la
Intendencia (`/operacion`) muestra el incidente sola, sin tocar nada; (3) a la persona logueada como cuadrilla
(`unidad.cuadrilla-demo`) le llega la orden en `/unidad`, también sola, y la acepta, la inicia y la completa.

Verificado el 18 oct 2026 en local, con build de producción, Jev, DeepSeek y Nominatim reales: el incidente aparece
en `/operacion` unos 2 s después de enviar y la orden llega a la cuadrilla unos 3 s después (polling de 3 s). Se
probaron seis relatos distintos: fuego con dirección, fuego sin dirección, bache, basura, rama caída y foto de un contenedor
quemado. En todos la orden llegó a `cuadrilla-demo`.

## Antes de la demo

```bash
pnpm build                                 # la demo va con build de producción: sin el indicador de `next dev`
pnpm cli seed-demo                         # crea cuadrilla-demo y unidad.cuadrilla-demo si faltan
pnpm cli reset-demo --yes                  # estado limpio (borra incidentes, reportes y órdenes)
pnpm cli refresh-demo-positions --near -34.9058,-56.1882 --watch 10   # deja abierta esta terminal
node_modules/.bin/next start --port 3000 & pnpm worker
```

- `SESSION_SECRET` tiene que tener **32 caracteres o más**: si es más corto, el login de operación y de cuadrilla
  responde 500. Para generarlo: `openssl rand -hex 32`.
- `--near` tiene que caer en Montevideo y cerca de la dirección que se va a reportar (la cuadrilla atiende en un radio
  de 3 km). Las demás cuadrillas móviles quedan vencidas para que ninguna le gane la orden.
- Alumbrado no sirve para la demo: va por zona a la oficina, no a la cuadrilla.
- **Dónde correrla.** Lo mejor es el despliegue con https (Railway): ahí funciona todo, también desde los celulares.
  En una máquina local, `localhost` sirve para las pantallas de esa misma máquina. Para celulares por la red local
  (`http://192.168…`), ver el plan B de abajo: con `next start` por http, las cookies `secure` impiden iniciar sesión
  y el ciudadano pierde su borrador.
- Por http en la red local, el navegador bloquea la geolocalización. El ciudadano tiene que escribir la dirección (por
  ejemplo «18 de Julio y Ejido») y confirmar el pin con «Sí, es ahí».
- La cuadrilla escucha un tono y siente una vibración cuando llega la orden, solo si tocó la pantalla al menos una vez
  después de abrir `/unidad`: los navegadores bloquean el audio sin ese toque. El resaltado y el título de la pestaña
  funcionan igual.

### Plan B: celulares por la red local, sin https

```bash
ipconfig getifaddr en0 || ipconfig getifaddr en1          # IP de la máquina en la red, p. ej. 192.168.1.78
# reemplaza la última línea de arriba (`next start … & pnpm worker`): un solo servidor y un solo worker
ALLOWED_DEV_ORIGINS=192.168.1.78 node_modules/.bin/next dev --port 3000 & pnpm worker
# en los celulares: http://192.168.1.78:3000/reportar/montevideo, /login (operador y cuadrilla)
```

Se usa `next dev` porque en desarrollo las cookies no son `secure`. Muestra el indicador de Next abajo a la izquierda y
la primera carga de cada pantalla tarda unos segundos: abrir las tres pantallas antes de empezar. Verificado el 18 oct
con el recorrido en navegador contra la IP local: pasaron los tres actos.

## Verificar de punta a punta

Con web y worker andando y la demo recién reseteada:

```bash
node --env-file=.env.local scripts/e2e-demo.mjs http://localhost:3000                 # por HTTP, ~5 s
node --env-file=.env.local scripts/e2e-demo.mjs http://localhost:3000 --text "Hay un pozo enorme en 18 de Julio y Río Negro"
```

En un navegador real (Chrome instalado; `playwright-core` fuera del repo):

```bash
mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright-core@1.56.1)
NODE_PATH=/tmp/pw/node_modules node --env-file=.env.local scripts/e2e-demo-browser.mjs http://localhost:3000 --out /tmp/shots [--headed]
```

El de navegador abre `/operacion` y `/unidad` antes del reporte y nunca las recarga. Verifica que el incidente y la
orden aparezcan solos y resaltados, y que Aceptar → Iniciar trabajo → Completar funcione. Guarda capturas de cada acto.
Los dos scripts dejan el incidente resuelto: correr `reset-demo --yes` antes de la demo de verdad.
