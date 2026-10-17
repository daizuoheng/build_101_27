import { beforeAll, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { policies } from "../../seeds/policies";
import { getActiveCatalog } from "@/server/config/catalog";
import { getActivePolicy } from "@/server/config/policies";
import { renderTemplate } from "@/server/config/templates";
import { locatePoint } from "@/server/geo/locate";
import { resetDb, testDb } from "./setup";

async function counts(pool: Awaited<ReturnType<typeof testDb>>) {
  const { rows } = await pool.query(`select
    (select count(*) from problem_types)::int as types,
    (select count(*) from capabilities)::int as caps,
    (select count(*) from policy_versions where active)::int as policies,
    (select count(*) from message_templates)::int as templates,
    (select count(*) from areas)::int as areas,
    (select count(*) from problem_type_requirements)::int as reqs`);
  return rows[0];
}

describe("seeds y geografía", () => {
  beforeAll(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
  });

  it("son idempotentes y no pisan cambios de operación", async () => {
    const pool = await testDb();
    const before = await counts(pool);
    expect(before.types).toBe(10);
    expect(before.policies).toBe(7);
    expect(before.areas).toBe(62);

    await pool.query("update problem_types set name = 'Pozo (editado)' where slug = 'bache'");
    await seedAll(pool);
    expect(await counts(pool)).toEqual(before);
    const { rows } = await pool.query("select name from problem_types where slug = 'bache'");
    expect(rows[0].name).toBe("Pozo (editado)");
  });

  it("una política activa que ya no valida contra el esquema se versiona con la del seed; una válida editada no se toca", async () => {
    const pool = await testDb();
    const t = (await pool.query("select id from territories where slug = 'montevideo'")).rows[0].id;
    // Base sembrada antes del cambio de esquema: grouping v1 plana, con un radio ajustado por operación.
    await pool.query(
      `update policy_versions set config = '{"radius_m":40,"max_candidates":5,"same_threshold":0.9,"different_threshold":0.8,"conflict_band":0.15}'
       where territory_id = $1 and kind = 'grouping'`,
      [t],
    );
    await expect(getActivePolicy(pool, t, "grouping")).rejects.toThrow("pnpm cli seed");
    await seedAll(pool, { importAreas: false });
    const g = await pool.query("select version, active from policy_versions where territory_id = $1 and kind = 'grouping' order by version", [t]);
    expect(g.rows).toEqual([{ version: 1, active: false }, { version: 2, active: true }]);
    // Conserva el valor ajustado y el seed completa los campos nuevos.
    const republished = (await getActivePolicy(pool, t, "grouping")).config;
    expect(republished.radius_m).toBe(40);
    expect(republished.timeout_ms).toBe(policies.grouping.timeout_ms);

    // Operación cambia el radio publicando una versión válida: reseedear no la pisa.
    await pool.query(
      `update policy_versions set config = jsonb_set(config, '{radius_m}', '45') where territory_id = $1 and kind = 'grouping' and active`,
      [t],
    );
    await seedAll(pool, { importAreas: false });
    expect((await getActivePolicy(pool, t, "grouping")).config.radius_m).toBe(45);
    expect((await pool.query("select count(*)::int as n from policy_versions where territory_id = $1 and kind = 'grouping'", [t])).rows[0].n).toBe(2);

    // Restaura el estado que esperan los tests siguientes (comparten base).
    await pool.query("delete from policy_versions where territory_id = $1 and kind = 'grouping' and version = 2", [t]);
    await pool.query("update policy_versions set active = true, config = $2 where territory_id = $1 and kind = 'grouping'", [t, policies.grouping]);
  });

  it("sin ninguna versión activa, reseedear publica la del seed como versión nueva", async () => {
    const pool = await testDb();
    const t = (await pool.query("select id from territories where slug = 'montevideo'")).rows[0].id;
    await pool.query("update policy_versions set active = false where territory_id = $1 and kind = 'grouping'", [t]);
    await expect(getActivePolicy(pool, t, "grouping")).rejects.toThrow();
    await seedAll(pool, { importAreas: false });
    const g = await pool.query("select version, active from policy_versions where territory_id = $1 and kind = 'grouping' order by version", [t]);
    expect(g.rows).toEqual([{ version: 1, active: false }, { version: 2, active: true }]);
    expect((await getActivePolicy(pool, t, "grouping")).config.radius_m).toBe(policies.grouping.radius_m);

    await pool.query("delete from policy_versions where territory_id = $1 and kind = 'grouping' and version = 2", [t]);
    await pool.query("update policy_versions set active = true where territory_id = $1 and kind = 'grouping'", [t]);
  });

  it("lee políticas validadas, catálogo con hash y plantillas", async () => {
    const pool = await testDb();
    const t = (await pool.query("select id from territories where slug = 'montevideo'")).rows[0].id;
    const grouping = await getActivePolicy(pool, t, "grouping");
    expect(grouping.config.radius_m).toBe(30);
    const cat = await getActiveCatalog(pool, t);
    expect(cat.types).toHaveLength(10);
    expect(cat.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await renderTemplate(pool, t, "confirmation", { code: "AB12" })).toContain("AB12");
  });

  it("ubica un punto conocido en su barrio y rechaza uno fuera de cobertura", async () => {
    const pool = await testDb();
    const plaza = await locatePoint(pool, -56.1993, -34.9068); // Plaza Independencia
    expect(plaza?.areaName).toBe("CIUDAD VIEJA");
    expect(plaza?.territorySlug).toBe("montevideo");
    expect((await locatePoint(pool, -56.1645, -34.9011))?.areaName).toBe("TRES CRUCES");
    expect(await locatePoint(pool, -56.2, -35.1)).toBeNull(); // Río de la Plata
  });
});
