import { Pool, types, type PoolClient, type PoolConfig } from "pg";

// int8 (count, sum) como number: los conteos del dominio caben en 2^53.
types.setTypeParser(20, (v) => Number(v));

export type Db = Pool | PoolClient;

let pool: Pool | null = null;

/** Puerto del pooler transaccional de Supabase: no sirve (advisory lock del migrador y jobs necesitan sesión). */
const TRANSACTION_POOLER_PORT = "6543";

/** Hosts de loopback sin TLS. WHATWG URL deja IPv6 entre corchetes; "" es socket Unix (`postgres:///db`). */
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "[::1]"]);

/** Archivos de certificado en la URL: `pg` los leería del disco; acá el certificado entra por `DATABASE_CA_CERT`. */
const SSL_FILE_PARAMS = ["sslcert", "sslkey", "sslrootcert"];

/** Sin esto, una base inalcanzable o un pool lleno dejan colgados el healthcheck y las requests en vez de fallar. */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Configuración de conexión. Fuera de localhost siempre TLS:
 * - con `DATABASE_CA_CERT` (PEM del certificado raíz de Supabase) verifica servidor y nombre;
 * - sin él, cifra sin verificar (equivale a `sslmode=require`).
 * `sslmode=disable` en la URL apaga TLS (Postgres de CI o red privada sin TLS). El resto de `sslmode`
 * se descarta porque `pg` lo aplica por encima de `ssl` y `sslmode=require` pasaría a exigir verificación
 * sin CA; `sslcert`/`sslkey`/`sslrootcert` se rechazan para no perder la verificación en silencio.
 */
export function poolConfig(connectionString: string, env: Record<string, string | undefined> = process.env): PoolConfig {
  const url = new URL(connectionString);
  if (url.port === TRANSACTION_POOLER_PORT) {
    throw new Error("DATABASE_URL apunta al pooler transaccional (puerto 6543): usá el modo sesión (puerto 5432)");
  }
  const fileParam = SSL_FILE_PARAMS.find((k) => url.searchParams.has(k));
  if (fileParam) throw new Error(`DATABASE_URL trae ${fileParam}: no se admite; pasá el certificado raíz en DATABASE_CA_CERT`);
  const disabled = url.searchParams.get("sslmode") === "disable";
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);

  const max = env.DATABASE_POOL_MAX ? Number(env.DATABASE_POOL_MAX) : 10;
  if (!Number.isInteger(max) || max < 1) throw new Error(`DATABASE_POOL_MAX inválido: "${env.DATABASE_POOL_MAX}" (entero ≥ 1)`);

  const ca = env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
  return {
    connectionString: url.toString(),
    max,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ssl: disabled ? false : LOCAL_HOSTS.has(url.hostname) ? undefined : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
  };
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
