import bcrypt from "bcryptjs";
import type { Db } from "../src/server/db/pool";

/** Contraseña de todas las cuentas de demo (operador y unidades). Son cuentas de demo, no de producción. */
export const DEMO_PASSWORD = "test";

/**
 * Cuentas internas de demo: operador del territorio y un usuario por unidad de demo, todas con `DEMO_PASSWORD`.
 * Inserta lo ausente por username y a las existentes les vuelve a poner `DEMO_PASSWORD` (las sembradas antes con
 * otra contraseña quedan alineadas). Devuelve solo las creadas. Llamar dentro de la transacción del seed.
 */
export async function seedDemoUsers(db: Db, territorySlug: string): Promise<string[]> {
  const t = await db.query<{ id: string }>("select id from territories where slug = $1", [territorySlug]);
  if (!t.rows[0]) throw new Error(`territorio inexistente: ${territorySlug}`);
  const territoryId = t.rows[0].id;
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const created: string[] = [];

  // xmax = 0 solo en la fila recién insertada; en la actualizada por el conflicto no.
  const username = `operador.${territorySlug}`;
  const res = await db.query<{ inserted: boolean }>(
    `insert into internal_users (username, password_hash, role, territory_id) values ($1, $2, 'operator', $3)
     on conflict (username) do update set password_hash = excluded.password_hash
     returning (xmax = 0) as inserted`,
    [username, hash, territoryId],
  );
  if (res.rows[0]?.inserted) created.push(username);

  const units = await db.query<{ id: string; slug: string }>("select id, slug from response_units where territory_id = $1 and is_demo", [territoryId]);
  for (const u of units.rows) {
    const name = `unidad.${u.slug}`;
    const r = await db.query<{ inserted: boolean }>(
      `insert into internal_users (username, password_hash, role, territory_id, response_unit_id) values ($1, $2, 'unit', $3, $4)
       on conflict (username) do update set password_hash = excluded.password_hash
       returning (xmax = 0) as inserted`,
      [name, hash, territoryId, u.id],
    );
    if (r.rows[0]?.inserted) created.push(name);
  }
  return created;
}
