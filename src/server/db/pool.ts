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

/** Host efectivo como lo resuelve `pg-connection-string`: `?host=` pisa al de la URL; `/…` es un socket Unix. */
function isLocal(url: URL): boolean {
  const host = (url.searchParams.get("host") ?? decodeURIComponent(url.hostname)).toLowerCase();
  return LOCAL_HOSTS.has(host) || host.startsWith("/");
}

/**
 * TLS según la URL y `DATABASE_CA_CERT`. `pg` aplica los `ssl*` de la URL por encima de `ssl`, así que
 * `poolConfig` los saca de la URL y esta función decide sola.
 */
function resolveSsl(url: URL, ca: string | undefined): PoolConfig["ssl"] {
  const mode = url.searchParams.get("sslmode");
  if (mode === "disable") return false;
  if (VERIFY_MODES.has(mode ?? "") && !ca) throw new Error(`DATABASE_URL pide sslmode=${mode} pero falta DATABASE_CA_CERT`);
  if (isLocal(url)) return undefined;
  // Con CA se verifica servidor y nombre; sin ella se cifra sin verificar (lo que libpq llama `sslmode=require`).
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

/**
 * Configuración de conexión. Fuera de localhost siempre TLS (ver `resolveSsl`); `sslmode=disable` lo apaga
 * (Postgres de CI o red privada sin TLS). `sslmode=require` se descarta porque `pg` 8 lo trata como `verify-full`
 * y fallaría sin CA; `sslcert`/`sslkey`/`sslrootcert` se rechazan para no perder la verificación en silencio.
 */
export function poolConfig(connectionString: string, env: Record<string, string | undefined> = process.env): PoolConfig {
  const url = new URL(connectionString);
  if (url.port === TRANSACTION_POOLER_PORT) {
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
  return new Pool(poolConfig(connectionString));
}

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no está configurada");
    pool = createPool(url);
  }
  return pool;
}
