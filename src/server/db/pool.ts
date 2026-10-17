import { Pool, types, type PoolClient, type PoolConfig } from "pg";

// int8 (count, sum) como number: los conteos del dominio caben en 2^53.
types.setTypeParser(20, (v) => Number(v));

export type Db = Pool | PoolClient;

let pool: Pool | null = null;

/** Puerto del pooler transaccional de Supabase: no sirve (advisory lock del migrador y jobs necesitan sesión). */
const TRANSACTION_POOLER_PORT = "6543";

/** Hosts de loopback sin TLS. WHATWG URL deja IPv6 entre corchetes; "" es el host por defecto (`postgres:///db`). */
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "[::1]", "::1"]);

/** Archivos de certificado en la URL: `pg` los leería del disco; acá el certificado entra por `DATABASE_CA_CERT`. */
const SSL_FILE_PARAMS = ["sslcert", "sslkey", "sslrootcert"];

/** Modos que piden verificar el certificado: sin CA no se pueden cumplir y no se degradan en silencio. */
const VERIFY_MODES = new Set(["verify-ca", "verify-full"]);

/** `prefer`/`allow` de libpq caen a texto plano si el servidor no tiene TLS; `pg` no sabe hacerlo y no se finge. */
const SSL_MODES = new Set(["disable", "require", ...VERIFY_MODES]);

/** Host efectivo como lo resuelve `pg-connection-string`: `?host=` pisa al de la URL; `/…` es un socket Unix. */
function isLocal(url: URL): boolean {
  const host = (url.searchParams.get("host") ?? decodeURIComponent(url.hostname)).toLowerCase();
  return LOCAL_HOSTS.has(host) || host.startsWith("/");
}

/**
 * TLS según la URL y `DATABASE_CA_CERT`. `pg` aplica los `ssl*` de la URL por encima de `ssl`, así que
 * `poolConfig` los saca de la URL y esta función decide sola. Sin `sslmode`: local sin TLS, remoto con TLS.
 * Un `sslmode` explícito manda también en local (túnel o proxy hacia la base remota).
 */
function resolveSsl(url: URL, ca: string | undefined): PoolConfig["ssl"] {
  const raw = url.searchParams.get("sslmode");
  const mode = raw?.toLowerCase();
  if (mode !== undefined && !SSL_MODES.has(mode)) {
    throw new Error(`DATABASE_URL trae sslmode=${raw}: no se admite; usá disable, require, verify-ca o verify-full`);
  }
  if (mode === "disable") return false;
  if (mode && VERIFY_MODES.has(mode) && !ca) throw new Error(`DATABASE_URL pide sslmode=${raw} pero falta DATABASE_CA_CERT`);
  if (!mode && isLocal(url)) return undefined;
  // Con CA se verifica servidor y nombre (también para verify-ca); sin ella se cifra sin verificar (`require` de libpq).
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

/**
 * Configuración de conexión. Fuera de localhost siempre TLS (ver `resolveSsl`); `sslmode=disable` lo apaga
 * (Postgres de CI o red privada sin TLS). `sslmode` no llega a `pg` porque `pg` 8 trata `require` como `verify-full`
 * y fallaría sin CA; `sslcert`/`sslkey`/`sslrootcert` se rechazan para no perder la verificación en silencio.
 */
export function poolConfig(connectionString: string, env: Record<string, string | undefined> = process.env): PoolConfig {
  const url = new URL(connectionString);
  // Como `host`, `?port=` pisa al puerto de la URL en `pg-connection-string`.
  if ((url.searchParams.get("port") ?? url.port) === TRANSACTION_POOLER_PORT) {
    throw new Error("DATABASE_URL apunta al pooler transaccional (puerto 6543): usá el modo sesión (puerto 5432)");
  }
  const fileParam = SSL_FILE_PARAMS.find((k) => url.searchParams.has(k));
  if (fileParam) throw new Error(`DATABASE_URL trae ${fileParam}: no se admite; pasá el certificado raíz en DATABASE_CA_CERT`);

  const max = env.DATABASE_POOL_MAX ? Number(env.DATABASE_POOL_MAX) : 10;
  if (!Number.isInteger(max) || max < 1) throw new Error(`DATABASE_POOL_MAX inválido: "${env.DATABASE_POOL_MAX}" (entero ≥ 1)`);

  const ssl = resolveSsl(url, env.DATABASE_CA_CERT?.replace(/\\n/g, "\n") || undefined);
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);
  return { connectionString: url.toString(), max, ssl };
}

export function createPool(connectionString: string): Pool {
  const p = new Pool(poolConfig(connectionString));
  // Una conexión ociosa que el servidor corta (reinicio de Supavisor, mantenimiento, red) emite `error` en el pool;
  // sin listener sería una excepción no capturada que tira el proceso. El pool ya descarta ese cliente.
  p.on("error", (e) => console.error("pg pool: conexión ociosa perdida:", e.message));
  return p;
}

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no está configurada");
    pool = createPool(url);
  }
  return pool;
}
