// Publica como nueva versión activa la política del seed para un kind, si difiere de la activa.
// Los seeds solo insertan la versión 1 y nunca pisan filas; esto versiona en lugar de editar.
// Uso: pnpm tsx scripts/policy-upgrade.ts <kind> [--territory montevideo]
import { isDeepStrictEqual } from "node:util";
import { loadEnv } from "../src/server/env";
import { getPool } from "../src/server/db/pool";
import { withTx } from "../src/server/db/tx";
import { policies } from "../seeds/policies";

loadEnv();
const kind = process.argv[2] as keyof typeof policies;
const ti = process.argv.indexOf("--territory");
const territory = ti > 0 ? process.argv[ti + 1] : "montevideo";
if (!kind || !(kind in policies)) {
  console.error(
    `uso: policy-upgrade <${Object.keys(policies).join(" | ")}> [--territory slug]`,
  );
  process.exit(1);
}

async function main() {
  const pool = getPool();
  const result = await withTx(async (c) => {
    const t = await c.query<{ id: string }>(
      "select id from territories where slug = $1",
      [territory],
    );
    if (!t.rows[0]) throw new Error(`territorio inexistente: ${territory}`);
    const territoryId = t.rows[0].id;
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [
      `policy:${territoryId}:${kind}`,
    ]);
    const active = await c.query<{ version: number; config: unknown }>(
      "select version, config from policy_versions where territory_id = $1 and kind = $2 and active",
      [territoryId, kind],
    );
    const config = JSON.parse(JSON.stringify(policies[kind]));
    if (active.rows[0] && isDeepStrictEqual(active.rows[0].config, config))
      return `sin cambios (versión ${active.rows[0].version})`;
    const next = await c.query<{ v: number }>(
      "select coalesce(max(version), 0) + 1 as v from policy_versions where territory_id = $1 and kind = $2",
      [territoryId, kind],
    );
    await c.query(
      "update policy_versions set active = false where territory_id = $1 and kind = $2 and active",
      [territoryId, kind],
    );
    await c.query(
      "insert into policy_versions (territory_id, kind, version, config, active) values ($1, $2, $3, $4, true)",
      [territoryId, kind, next.rows[0].v, config],
    );
    return `${kind}: versión ${next.rows[0].v} activa (antes ${active.rows[0]?.version ?? "ninguna"})`;
  }, pool);
  console.log(result);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
