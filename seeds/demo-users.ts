import bcrypt from "bcryptjs";
import type { Pool } from "pg";

/**
 * Cuentas internas de demo. Contraseñas solo por entorno; si faltan, falla (no hay contraseña por defecto).
 * Inserta lo ausente por username y no cambia contraseñas existentes.
 */
export async function seedDemoUsers(pool: Pool, territorySlug: string): Promise<string[]> {
  const opPass = process.env.DEMO_OPERATOR_PASSWORD;
  if (!opPass) throw new Error("Falta DEMO_OPERATOR_PASSWORD");
  const t = await pool.query<{ id: string }>("select id from territories where slug = $1", [territorySlug]);
  if (!t.rows[0]) throw new Error(`territorio inexistente: ${territorySlug}`);
  const created: string[] = [];
  const username = `operador.${territorySlug}`;
  const res = await pool.query(
    `insert into internal_users (username, password_hash, role, territory_id) values ($1, $2, 'operator', $3)
     on conflict (username) do nothing`,
    [username, await bcrypt.hash(opPass, 10), t.rows[0].id],
  );
  if (res.rowCount) created.push(username);

  const unitPass = process.env.DEMO_UNIT_PASSWORD;
  const units = await pool.query<{ id: string; slug: string }>("select id, slug from response_units where territory_id = $1 and is_demo", [t.rows[0].id]);
  if (units.rows.length && !unitPass) throw new Error("Falta DEMO_UNIT_PASSWORD");
  for (const u of units.rows) {
    const name = `unidad.${u.slug}`;
    const r = await pool.query(
      `insert into internal_users (username, password_hash, role, territory_id, response_unit_id) values ($1, $2, 'unit', $3, $4)
       on conflict (username) do nothing`,
      [name, await bcrypt.hash(unitPass!, 10), t.rows[0].id, u.id],
    );
    if (r.rowCount) created.push(name);
  }
  return created;
}
