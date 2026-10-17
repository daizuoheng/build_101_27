import { Pool, types, type PoolClient, type PoolConfig } from "pg";

// int8 (count, sum) como number: los conteos del dominio caben en 2^53.
types.setTypeParser(20, (v) => Number(v));

export type Db = Pool | PoolClient;

let pool: Pool | null = null;

/** Puerto del pooler transaccional de Supabase: no sirve (advisory lock del migrador y jobs necesitan sesión). */
const TRANSACTION_POOLER_PORT = "6543";

/**
 * Configuración de conexión. Fuera de localhost siempre TLS:
 * - con `DATABASE_CA_CERT` (PEM del certificado raíz de Supabase) verifica servidor y nombre;
 * - sin él, cifra sin verificar (equivale a `sslmode=require`).
 * Los parámetros `ssl*` de la URL se descartan porque `pg` los aplica por encima de `ssl`
 * y `sslmode=require` pasaría a exigir verificación sin CA.
 */
export function poolConfig(connectionString: string, env: Record<string, string | undefined> = process.env): PoolConfig {
  const url = new URL(connectionString);
  if (url.port === TRANSACTION_POOLER_PORT) {
    throw new Error("DATABASE_URL apunta al pooler transaccional (puerto 6543): usá el modo sesión (puerto 5432)");
  }
  const local = url.hostname === "" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);
  const ca = env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
  return {
    connectionString: url.toString(),
    max: Number(env.DATABASE_POOL_MAX ?? 10),
    ssl: local ? undefined : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
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
