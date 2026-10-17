# Despliegue — Railway (web + worker) y Supabase (PostGIS + Storage privado)

Estado al 17 oct 2026: **preparado, no desplegado**. Las cuentas de Railway y Supabase todavía no existen. Lo que dice
"verificado" acá se probó en local; lo marcado **sin verificar** depende de las cuentas y no se simuló.

## Decisiones

- **Builder nativo de Railway (Railpack), sin Dockerfile.** Según la documentación de Railpack, detecta pnpm por
  `packageManager`, Node por `engines.node` (26.x) y cachea `.next/cache`; no deja imagen que mantener. La única
  dependencia nativa es `sharp`, que trae binarios precompilados para linux x64 (`pg` es JavaScript puro). El build real
  de Railpack está **sin verificar** (abajo).
- **Configuración como código en `.railway/railway.ts`** (SDK `railway/iac`). `railway.json` está deprecado: los
  servicios nuevos ya no pueden usarlo y se deja de leer el 1 dic 2026. El IaC es declarativo sobre todo el proyecto:
  lo que falte en el archivo (servicios, variables) `apply` lo marca para borrar, con confirmación.
  `pnpm typecheck` verifica también este archivo (`.railway/tsconfig.json`: el `include` raíz no entra en carpetas con
  punto).
- **Dos servicios del mismo repo**, rama `main`:
  - `web`: build `pnpm build`; arranca con `node_modules/.bin/next start` (toma `$PORT`); healthcheck `/api/health`
    (responde 200 si llega a la base). Se redespliega con cualquier cambio salvo `docs/`, los `.md` de la raíz y
    `.railway/` (`next build` verifica tipos de todo el `include` de tsconfig, así que tests, seeds y scripts cuentan).
  - `worker`: build `tsc --noEmit -p .railway/tsconfig.worker.json` (no necesita `next build`): verifica los tipos
    solo de lo que importa `src/worker/index.ts` (`src/server`, `src/shared`), así un error que esté solo en `src/app`
    no frena su despliegue. Arranca con `node_modules/.bin/tsx src/worker/index.ts`. Solo se redespliega si cambia lo
    que verifica, lo que lee en ejecución o su pre-deploy (`watchPatterns`: `src/server`, `src/shared`, `src/worker`,
    `migrations`, `scripts/cli.ts`, `tsconfig.json`, `package.json`, archivos de pnpm y su tsconfig).
  - `pnpm typecheck` (local/CI) corre `next typegen` antes de `tsc`, porque en un clon limpio no existen
    `next-env.d.ts` ni los tipos de rutas como `RouteContext`, y verifica también `.railway/railway.ts`.
  - En los dos, el arranque usa el binario directo y no `pnpm start`: verificado en local que pnpm no reenvía SIGTERM
    al hijo, y con el binario directo el worker termina el job en curso y escribe `worker detenido`.
- **Migraciones** como comando previo al despliegue (`pnpm cli migrate`) en los dos servicios; el advisory lock del
  migrador serializa si corren a la vez y el segundo encuentra `sin migraciones pendientes`. Va en los dos para que el
  código nuevo de cualquiera de ellos nunca arranque contra el esquema viejo, despliegue el que despliegue primero.
  Una migración fallida frena el despliegue.
- **Seeds**: comandos manuales de una sola vez (abajo), nunca en el despliegue.
- **Postgres de Supabase en modo sesión** (Supavisor, puerto **5432**, usuario `postgres.<ref>`, IPv4). El advisory
  lock del migrador y el `FOR UPDATE SKIP LOCKED` con lease de los jobs necesitan sesión. `createPool` **rechaza el
  puerto 6543** (pooler transaccional) con un error explícito. La conexión directa (`db.<ref>.supabase.co`) es solo
  IPv6 sin el add-on pago, así que desde Railway se usa el pooler de sesión.
- **TLS**: sin `sslmode` en la URL, sin TLS en local (`localhost`, `127.0.0.1`, `[::1]` o socket Unix, respetando
  `?host=` como `pg`) y con TLS en cualquier otro host. Con `DATABASE_CA_CERT` (certificado raíz de Supabase en PEM)
  se verifica servidor y nombre; sin él se cifra sin verificar (lo que libpq llama `sslmode=require`). `sslmode` no
  llega a `pg` a propósito: `pg-connection-string` 2.14 (el de `pg` 8.23) trata `sslmode=require` como `verify-full`
  y fallaría sin CA. Un `sslmode` explícito (sin distinguir mayúsculas; `?ssl=0|false|1|true` cuenta como `disable` o
  `require`) manda también en local:
  - `disable`: sin TLS (Postgres de CI o de red privada sin TLS; un Postgres de contenedor con host `db`/`postgres`
    cuenta como remoto y lo necesita, igual que antes de este cambio);
  - `require`: TLS; con CA verifica la cadena (no el nombre, como libpq); `no-verify` (de `pg`): TLS sin verificar
    aunque haya CA;
  - `verify-ca`/`verify-full`: exigen `DATABASE_CA_CERT` (si falta, error en vez de conectarse sin verificar);
    `verify-full` verifica cadena y nombre, `verify-ca` solo la cadena (como libpq: sirve por túnel o por IP);
  - `prefer`/`allow` u otro valor: error (`pg` no sabe caer a texto plano como libpq).
  `sslcert`/`sslkey`/`sslrootcert` en la URL dan error en vez de ignorarse. El rechazo del puerto 6543 mira también
  `?port=`.
- **Pool**: `DATABASE_POOL_MAX` vacío usa 10; un valor que no sea entero ≥ 1 falla al arrancar. Si el servidor corta
  una conexión (reinicio de Supavisor, mantenimiento), ociosa o tomada por una transacción, se loguea
  `pg: conexión perdida` en vez de tirar el proceso (la consulta en curso falla con ese error). `keepAlive` detecta
  conexiones medio abiertas. El pool no tiene timeout de conexión (con el pool lleno las requests esperan turno, como
  antes). `/api/health` usa un pool propio de 1 conexión con topes de 3 s para conectar (o esperar turno) y 2 s para
  la consulta, que cierra la conexión al segundo de quedar ociosa: con la base caída o un handshake trabado responde
  503 en vez de quedar colgado, y no compite con la app por el pool.
- **Reinicios**: web y worker con `restartPolicyType: ALWAYS`, para que una racha de caídas durante un corte de la
  base no deje el servicio parado cuando vuelva.
- **Drenaje del worker**: Railway da por defecto 0 s entre SIGTERM y SIGKILL al desplegar; el worker declara
  `drainingSeconds: 60` (el lease de un job) para que el apagado limpio llegue a correr. **Sin verificar:** que el
  campo del SDK se traduzca en `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`; revisarlo en `railway config plan`.
- **Conexiones a Supabase**: en modo sesión cada cliente ocupa un backend del pool de Supavisor. Web usa hasta 4 y
  worker hasta 3; durante un redeploy pueden coexistir el despliegue viejo y el nuevo: (4 + 3) × 2 = 14, más 1 del
  migrador del pre-deploy y 1 del healthcheck de web. `pg` abre conexiones a demanda y cierra las ociosas a los 10 s,
  así que 16 es el peor caso.
  **Sin verificar:** el pool size por defecto del plan (Database Settings → Connection pooling); si es menor que 16,
  subirlo ahí o bajar `DATABASE_POOL_MAX` en el IaC. Síntoma si no alcanza: errores de "max clients" en los logs.
- **Storage**: `STORAGE_DRIVER=supabase` sobre un bucket **privado**; las fotos se sirven solo a través de la app
  tras autorizar. En Railway (`RAILWAY_ENVIRONMENT_ID` definida), `STORAGE_DRIVER=local` falla a propósito en el primer
  uso del storage (web y worker no comparten disco); el IaC ya fija `STORAGE_DRIVER=supabase`.
  Con claves nuevas (`sb_secret_…`) el driver manda solo `apikey`; con la `service_role` heredada (JWT) manda además
  `Authorization: Bearer`.

## Variables por servicio (sin valores)

| Variable | web | worker | Notas |
|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | Supabase → Connect → **Session pooler** (puerto 5432). Secreto. |
| `DATABASE_CA_CERT` | opcional | opcional | PEM de Database Settings → SSL; se puede pegar con `\n` escapados. **No está en el IaC**: ver abajo. |
| `DATABASE_POOL_MAX` | `4` | `3` | Ya en el IaC. El pooler de sesión cuenta cada conexión contra el límite del plan. |
| `TYPESAFE_API_KEY` | ✓ | ✓ | Jev. Secreto. |
| `LLM_BASE_URL` | ✓ | ✓ | `https://api.deepseek.com` (ya en el IaC). |
| `LLM_API_KEY` | ✓ | ✓ | DeepSeek. Secreto. |
| `LLM_MODEL` | ✓ | ✓ | `deepseek-flash` (respaldo; el modelo efectivo sale de la política). |
| `STORAGE_DRIVER` | ✓ | ✓ | `supabase` (ya en el IaC). |
| `SUPABASE_URL` | ✓ | ✓ | `https://<ref>.supabase.co`. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | Clave secreta (`sb_secret_…`) o `service_role` heredada. Secreto. Nunca al navegador. |
| `SUPABASE_BUCKET` | ✓ | ✓ | `report-photos` (ya en el IaC). |
| `NOMINATIM_USER_AGENT` | ✓ | ✓ | Identificable, con contacto del equipo (política de uso de Nominatim). |
| `SESSION_SECRET` | ✓ | — | ≥ 32 caracteres aleatorios (`openssl rand -hex 32`). Secreto. |

`PORT` y `NODE_ENV` los pone Railway/Railpack. Las contraseñas de demo (`DEMO_OPERATOR_PASSWORD`, `DEMO_UNIT_PASSWORD`)
**no** van en Railway: solo las usa `seed-demo`, que se corre desde una máquina del equipo.

En `.railway/railway.ts` los secretos están como `preserve()`: el archivo declara la variable y el valor se carga en
Railway, nunca en el repo. La documentación de Railway define `preserve()` como "conservar el valor que ya está en
Railway" y no dice qué hace `apply` si la variable todavía no existe (**sin verificar**; ver el paso 3.4).

`DATABASE_CA_CERT` se dejó fuera del IaC porque es opcional y no se sabe si `apply` acepta un `preserve()` sin valor.
Para activarla: cargarla en los dos servicios (`railway variables --service web --set DATABASE_CA_CERT=…`, ídem
`worker`), agregar `DATABASE_CA_CERT: preserve()` a `shared` en `.railway/railway.ts` y correr `railway config plan`:
si no se declara, el siguiente `apply` la marca para borrar.

## Pasos cuando lleguen las cuentas

### 1. Supabase

1. Crear el proyecto (región más cercana a Railway; anotar la contraseña de la base en el gestor del equipo).
2. SQL Editor:
   ```sql
   create extension if not exists postgis with schema extensions;
   show search_path; -- debe incluir extensions; si no: alter role postgres set search_path = "$user", public, extensions;
   ```
   La migración `0001` hace `create extension if not exists postgis`, que queda en no-op.
3. Storage → New bucket → nombre `report-photos`, **Public: off**, límite de archivo 15 MB, tipos `image/*`.
   Equivalente en SQL:
   ```sql
   insert into storage.buckets (id, name, public, file_size_limit)
   values ('report-photos', 'report-photos', false, 15728640);
   ```
   No crear políticas RLS de lectura pública: la app accede con la clave de servicio.
4. Connect → **Session pooler** → copiar la URL (puerto 5432, usuario `postgres.<ref>`). Project Settings → API Keys →
   clave secreta. Database Settings → SSL → descargar el certificado (opcional, para `DATABASE_CA_CERT`).

### 2. Base: migrar y cargar datos (una vez, desde una Mac del equipo)

`loadEnv` no pisa variables ya definidas, así que alcanza con anteponer la URL de Supabase:

```bash
export DATABASE_URL='postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres'
pnpm cli migrate
pnpm cli seed                                   # catálogo, políticas, plantillas, Montevideo y sus barrios
DEMO_OPERATOR_PASSWORD=… DEMO_UNIT_PASSWORD=… pnpm cli seed-demo
pnpm cli policy-upgrade --kind grouping         # no-op en una base recién sembrada; versiona si la activa difiere del seed
pnpm cli refresh-demo-positions                 # antes de cada demo: las posiciones vencen por política
unset DATABASE_URL
```

### 3. Railway

1. Instalar la CLI (≥ 5.42.1, la que evalúa `railway/iac`), `railway login`, crear el proyecto vacío y `railway link`.
2. Conectar la app de GitHub de Railway con acceso a `daizuoheng/build_101_27`.
3. `railway config plan` → revisar que cree `web` y `worker` → `railway config apply`.
4. Cargar los secretos en los dos servicios (dashboard → Variables, o `railway variables --service web --set K=V`).
   **Sin verificar:** qué hace `apply` con un `preserve()` de una variable que todavía no existe (puede rechazarlo,
   saltearlo o crearla vacía). Si lo rechaza, como los servicios aún no existen: comentar temporalmente esas líneas,
   `apply`, cargar los valores con `railway variables`, restaurar los `preserve()` y repetir `plan`/`apply` (no debe
   proponer cambios en las variables).
   Si el despliegue automático arranca antes de tener los secretos, falla en el pre-deploy (sin `DATABASE_URL`):
   es esperable; redesplegar después de cargarlos.
5. Settings → Networking → **Generate Domain** en `web`. El importador de Railway deja fuera los dominios generados;
   **sin verificar** si un `apply` posterior propone borrarlo: correr `railway config plan` y, si lo propone, traerlo al
   archivo con `railway config pull` antes de aplicar.
6. Despliegue con secretos: en los logs de `web` debe verse `sin migraciones pendientes` (o `aplicadas: …`) en el
   pre-deploy y el healthcheck en verde; en `worker`, `worker … iniciado`.

### 4. Verificación desde un celular (por datos móviles, no por la red de la oficina)

1. `https://<dominio>/api/health` → `{"ok":true}`.
2. `https://<dominio>/reportar/montevideo`: mandar un reporte con **foto real** y ubicación por GPS; confirmar y
   anotar el código. Verifica Jev, LLM, Nominatim y la subida al bucket.
3. En Supabase → Storage → `report-photos`: aparecen el original y el derivado para Jev. Abrir la URL pública del
   objeto debe dar error (bucket privado).
4. En la Mac, `https://<dominio>/login` con la cuenta de operador de demo → `/operacion`: el incidente aparece con
   barrio y prioridad. En los logs del worker: `✓ process_report …`.
5. Desde la máquina del equipo: `node --env-file=.env.local scripts/e2e-walkthrough.mjs https://<dominio>`
   (necesita `DEMO_OPERATOR_PASSWORD`).
6. Redeploy del worker con un job en curso: en los logs debe aparecer `worker detenido` (apagado limpio).

## Verificado en local (17 oct)

- `pnpm build` sin advertencias (se corrigió el rastreo de todo el proyecto que causaba `path.resolve` dinámico en
  `src/server/storage/adapter.ts`).
- `PORT=3204 pnpm start` + `pnpm worker` contra `radar_urbano_despliegue`: `/api/health` 200, `/`, `/reportar/montevideo`
  200; `scripts/e2e-walkthrough.mjs http://localhost:3204` completo con Jev, DeepSeek y Nominatim reales
  (`process_report` en 39 ms en el worker).
- SIGTERM al proceso `tsx` → `worker detenido`. SIGTERM a `pnpm worker` → el hijo no imprime el cierre: por eso el
  arranque usa los binarios directos.
- `.railway/railway.ts` compila con el SDK `railway@3.16.0` y su evaluación produce los dos servicios esperados;
  `pnpm typecheck` lo verifica (un campo mal escrito, p. ej. `healthcheckTimeot`, da error).
- `pnpm typecheck` en un clon limpio (sin `next-env.d.ts` ni `.next/`): pasa gracias a `next typegen`.
- Con `DATABASE_URL` apuntando a un host inalcanzable, `/api/health` responde 503.
- El build del worker (`tsc -p .railway/tsconfig.worker.json`) pasa en un clon limpio, sin `next typegen`.
- Tests unitarios de `poolConfig`/`createPool`: TLS y CA; hosts locales (IPv6, mayúsculas, socket, `?host=`); cada
  `sslmode` y `?ssl=`; rechazo de 6543 (también `?port=`) y de `sslrootcert`; `DATABASE_POOL_MAX` vacío o inválido;
  `keepAlive`; conexión cortada (ociosa o tomada) sin tirar el proceso.
- Tres `/api/health` simultáneos con la base inalcanzable: los tres 503 en ~3 s.

## Bloqueado hasta tener cuentas (no simulado)

- Driver de Supabase Storage contra un bucket real (subida, lectura, rechazo de acceso público).
- Conexión al pooler de sesión de Supabase con TLS y, si se carga, con el certificado.
- `railway config plan/apply` (la CLI de Railway no está instalada y no hay proyecto) y el build real de Railpack.
- Imagen Docker: no aplica (no hay Dockerfile) y Docker no estaba corriendo en esta Mac.
- Verificación desde celular por internet.
