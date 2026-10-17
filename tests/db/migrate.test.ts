import { describe, expect, it } from "vitest";
import { migrate } from "@/server/db/migrate";
import { dropSchema, testDb } from "./setup";

describe("migrate", () => {
  it("aplica todas las migraciones sobre base vacía y es idempotente", async () => {
    const pool = await testDb();
    await dropSchema(pool);
    const first = await migrate(pool);
    expect(first.length).toBeGreaterThanOrEqual(6);
    expect(await migrate(pool)).toEqual([]);

    const { rows } = await pool.query("select postgis_version() as v, to_regclass('review_items') as r");
    expect(rows[0].v).toBeTruthy();
    expect(rows[0].r).not.toBeNull();
  });

  it("impide dos órdenes activas por incidente y dos vínculos activos por reporte (índices parciales)", async () => {
    const pool = await testDb();
    const { rows } = await pool.query(
      "select indexname from pg_indexes where indexname in ('assignments_one_active_per_incident', 'report_incident_links_one_active', 'policy_versions_one_active')",
    );
    expect(rows).toHaveLength(3);
  });
});
