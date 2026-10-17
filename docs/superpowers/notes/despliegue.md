# Despliegue — Railway (web + worker) y Supabase (PostGIS + Storage privado)

Estado al 17 oct 2026: **preparado, no desplegado**. Las cuentas de Railway y Supabase todavía no existen. Lo que dice
"verificado" acá se probó en local; lo marcado **sin verificar** depende de las cuentas y no se simuló.

## Decisiones

- **Builder nativo de Railway (Railpack), sin Dockerfile.** Detecta pnpm por `packageManager`, Node por `engines`
  (26.x), cachea `.next/cache` y no deja imagen que mantener. Las dos dependencias nativas (`sharp`, `pg`) traen
  binarios precompilados para linux x64.
- **Configuración como código en `.railway/railway.ts`** (SDK `railway/iac`). `railway.json` está deprecado: los
  servicios nuevos ya no pueden usarlo y se deja de leer el 1 dic 2026.
- **Dos servicios del mismo repo**, rama `main`:
  - `web`: build `pnpm build`; arranca con `node_modules/.bin/next start` (toma `$PORT`); healthcheck `/api/health`
    (responde 200 si llega a la base).
  - `worker`: build `pnpm typecheck` (no necesita `next build`); arranca con `node_modules/.bin/tsx src/worker/index.ts`.
  - En los dos, el arranque usa el binario directo y no `pnpm start`: verificado en local que pnpm no reenvía SIGTERM
    al hijo, y con el binario directo el worker termina el job en curso y escribe `worker detenido`.
- **Migraciones** como comando previo al despliegue (`pnpm cli migrate`) en los dos servicios; el advisory lock del
  migrador serializa si corren a la vez. Una migración fallida frena el despliegue.
- **Seeds**: comandos manuales de una sola vez (abajo), nunca en el despliegue.
- **Postgres de Supabase en modo sesión** (Supavisor, puerto **5432**, usuario `postgres.<ref>`, IPv4). El advisory
  lock del migrador y el `FOR UPDATE SKIP LOCKED` con lease de los jobs necesitan sesión. `createPool` **rechaza el
  puerto 6543** (pooler transaccional) con un error explícito. La conexión directa (`db.<ref>.supabase.co`) es solo
  IPv6 sin el add-on pago, así que desde Railway se usa el pooler de sesión.
- **TLS** siempre fuera de localhost. Con `DATABASE_CA_CERT` (certificado raíz de Supabase en PEM) se verifica
  servidor y nombre; sin él se cifra sin verificar (equivale a `sslmode=require`). Los parámetros `ssl*` de la URL se
  ignoran a propósito: `pg` 8 trata `sslmode=require` como `verify-full` y fallaría sin CA.
- **Storage**: `STORAGE_DRIVER=supabase` sobre un bucket **privado**; las fotos se sirven solo a través de la app
  tras autorizar. En Railway, `STORAGE_DRIVER=local` falla al arrancar a propósito (web y worker no comparten disco).
  Con claves nuevas (`sb_secret_…`) el driver manda solo `apikey`; con la `service_role` heredada (JWT) manda además
  `Authorization: Bearer`.

## Variables por servicio (sin valores)

| Variable | web | worker | Notas |
|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | Supabase → Connect → **Session pooler** (puerto 5432). Secreto. |
| `DATABASE_CA_CERT` | opcional | opcional | PEM de Database Settings → SSL. Se puede pegar con `\n` escapados. |
| `DATABASE_POOL_MAX` | `5` | `3` | Ya en el IaC. El pooler de sesión cuenta cada conexión contra el límite del plan. |
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
Railway, nunca en el repo.

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
pnpm cli policy-upgrade --kind grouping         # lo agrega la épica de agrupación (T9); si no existe aún, saltear
pnpm cli refresh-demo-positions                 # antes de cada demo: las posiciones vencen por política
unset DATABASE_URL
```

### 3. Railway

1. Instalar la CLI (≥ 5.42.1, la que evalúa `railway/iac`), `railway login`, crear el proyecto vacío y `railway link`.
2. Conectar la app de GitHub de Railway con acceso a `daizuoheng/build_101_27`.
3. `railway config plan` → revisar que cree `web` y `worker` → `railway config apply`.
4. Cargar los secretos en los dos servicios (dashboard → Variables, o `railway variables --service web --set K=V`).
   **Sin verificar:** si `apply` exige valor para las variables `preserve()` inexistentes, cargarlas primero con
   `railway variables` y repetir el `apply`.
5. Settings → Networking → **Generate Domain** en `web` (los dominios generados no se declaran en el IaC).
6. Primer despliegue: en los logs de `web` debe verse `sin migraciones pendientes` (o la lista aplicada) en el
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
- `.railway/railway.ts` compila con el SDK `railway@3.16.0` y su evaluación produce los dos servicios esperados.
- Tests unitarios de `poolConfig` (TLS, CA, rechazo de 6543, `sslmode` en la URL).

## Bloqueado hasta tener cuentas (no simulado)

- Driver de Supabase Storage contra un bucket real (subida, lectura, rechazo de acceso público).
- Conexión al pooler de sesión de Supabase con TLS y, si se carga, con el certificado.
- `railway config plan/apply` (la CLI de Railway no está instalada y no hay proyecto) y el build real de Railpack.
- Imagen Docker: no aplica (no hay Dockerfile) y Docker no estaba corriendo en esta Mac.
- Verificación desde celular por internet.
