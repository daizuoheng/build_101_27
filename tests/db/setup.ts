import type { Pool } from "pg";
import { createPool } from "@/server/db/pool";
import { migrate } from "@/server/db/migrate";

let pool: Pool | null = null;

/** Pool sobre `radar_urbano_test` con el esquema migrado. Usar `resetDb` para empezar de cero. */
export async function testDb(): Promise<Pool> {
  if (!pool) {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error("DATABASE_URL_TEST no está configurada");
    pool = createPool(url);
    await migrate(pool);
  }
  return pool;
}

/** Vacía todas las tablas del esquema (excepto schema_migrations). */
export async function resetDb(p: Pool): Promise<void> {
  const { rows } = await p.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename not in ('schema_migrations', 'spatial_ref_sys')",
  );
  if (rows.length) await p.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} cascade`);
}

/** Borra el esquema completo; solo para el test del migrador. */
export async function dropSchema(p: Pool): Promise<void> {
  await p.query("drop schema public cascade; create schema public;");
}
