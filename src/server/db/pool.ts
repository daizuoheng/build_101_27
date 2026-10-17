import { Pool, types, type PoolClient } from "pg";

// int8 (count, sum) como number: los conteos del dominio caben en 2^53.
types.setTypeParser(20, (v) => Number(v));

export type Db = Pool | PoolClient;

let pool: Pool | null = null;

export function createPool(connectionString: string): Pool {
  const host = new URL(connectionString).hostname;
  const local = host === "" || host === "localhost" || host === "127.0.0.1";
  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
}

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no está configurada");
    pool = createPool(url);
  }
  return pool;
}
