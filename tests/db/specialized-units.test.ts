import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { seedSpecializedUnits, specializedUnits } from "../../seeds/specialized-units";
import { capabilities, problemTypes } from "../../seeds/catalog";
import { resetDb, testDb } from "./setup";

describe("cuadrillas especializadas", () => {
  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
  });

  it("cubre el catálogo con capacidades distintas sin crear cuentas y conserva lo existente al repetir", async () => {
    const pool = await testDb();
    expect(await seedSpecializedUnits(pool)).toHaveLength(8);
    const { rows } = await pool.query(`select u.slug, array_agg(c.slug order by c.slug) as capabilities
      from response_units u join unit_capabilities uc on uc.unit_id=u.id
      join capabilities c on c.id=uc.capability_id group by u.slug`);
    expect(rows).toHaveLength(8);
    const sets = rows.map((r) => r.capabilities as string[]);
    expect(new Set(sets.map((s) => s.join(","))).size).toBe(8);
    for (const cap of capabilities) expect(sets.some((s) => s.includes(cap.slug))).toBe(true);
    for (const type of problemTypes) expect(sets.some((s) => type.requires.every((cap) => s.includes(cap)))).toBe(true);
    expect((await pool.query("select count(*)::int as n from internal_users")).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from area_responsibilities")).rows[0].n).toBe(2);
    expect((await pool.query("select count(*)::int as n from response_units where location_updated_at is not null")).rows[0].n).toBe(0);
    await pool.query("update response_units set capacity=4, status='out_of_service' where slug='cuadrilla-limpieza'");
    expect(await seedSpecializedUnits(pool)).toEqual([]);
    expect((await pool.query("select capacity, status from response_units where slug='cuadrilla-limpieza'")).rows[0])
      .toEqual({ capacity: 4, status: "out_of_service" });
    expect((await pool.query("select count(*)::int as n from events where kind='demo_seeded'")).rows[0].n).toBe(8);
    expect(specializedUnits.montevideo.map((u) => u.slug)).not.toContain("cuadrilla-demo");
  });

  it("revierte todo el lote si falta una capacidad", async () => {
    const pool = await testDb();
    await pool.query("delete from problem_type_requirements where capability_id=(select id from capabilities where slug='drenaje')");
    await pool.query("delete from capabilities where slug='drenaje'");
    await expect(seedSpecializedUnits(pool)).rejects.toThrow("capacidad inexistente: drenaje");
    expect((await pool.query("select count(*)::int as n from response_units")).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from events where kind='demo_seeded'")).rows[0].n).toBe(0);
  });
});
