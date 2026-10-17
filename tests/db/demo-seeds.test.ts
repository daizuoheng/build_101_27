import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { refreshDemoPositions, resetDemo, seedDemo } from "../../seeds/demo";
import { locatePoint } from "@/server/geo/locate";
import { allowedActions } from "@/shared/contracts/assignment";
import { resetDb, testDb } from "./setup";

describe("seeds de demo", () => {
  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
  });

  it("crea 4 unidades y sus usuarios; reseedear no duplica ni pisa cambios de operación", async () => {
    const pool = await testDb();
    const first = await seedDemo(pool, "montevideo");
    expect(first.unitsCreated).toHaveLength(4);
    expect(first.usersCreated).toEqual(expect.arrayContaining(["operador.montevideo", "unidad.cuadrilla-fuego"]));

    await pool.query("update response_units set capacity = 3 where slug = 'cuadrilla-limpieza'");
    const second = await seedDemo(pool, "montevideo");
    expect(second.unitsCreated).toEqual([]);
    const { rows } = await pool.query("select slug, capacity from response_units order by slug");
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.slug === "cuadrilla-limpieza").capacity).toBe(3);
  });

  it("es atómico: un error a mitad de la transacción revierte las unidades ya insertadas", async () => {
    const pool = await testDb();
    // Sin la capacidad 'fuego', las dos primeras unidades se insertan y la tercera (cuadrilla-fuego) falla.
    await pool.query("delete from problem_type_requirements where capability_id = (select id from capabilities where slug = 'fuego')");
    await pool.query("delete from capabilities where slug = 'fuego'");
    await expect(seedDemo(pool, "montevideo")).rejects.toThrow("capacidad inexistente: fuego");
    const left = await pool.query(`select (select count(*) from response_units)::int as units, (select count(*) from unit_capabilities)::int as caps,
      (select count(*) from internal_users)::int as users, (select count(*) from events where kind = 'demo_seeded')::int as events`);
    expect(left.rows[0]).toEqual({ units: 0, caps: 0, users: 0, events: 0 });
  });

  it("falla antes de escribir si falta la contraseña de unidad", async () => {
    const pool = await testDb();
    const saved = process.env.DEMO_UNIT_PASSWORD;
    delete process.env.DEMO_UNIT_PASSWORD;
    try {
      await expect(seedDemo(pool, "montevideo")).rejects.toThrow("DEMO_UNIT_PASSWORD");
    } finally {
      process.env.DEMO_UNIT_PASSWORD = saved;
    }
    const left = await pool.query("select (select count(*) from response_units)::int as units, (select count(*) from internal_users)::int as users");
    expect(left.rows[0]).toEqual({ units: 0, users: 0 });
  });

  it("capacidades, responsabilidad por zona y posiciones dentro de la cobertura", async () => {
    const pool = await testDb();
    await seedDemo(pool, "montevideo");
    const caps = await pool.query(
      `select u.slug, array_agg(c.slug order by c.slug) as caps from response_units u
       join unit_capabilities uc on uc.unit_id = u.id join capabilities c on c.id = uc.capability_id group by u.slug`,
    );
    const bySlug = Object.fromEntries(caps.rows.map((r) => [r.slug, r.caps]));
    expect(bySlug["cuadrilla-fuego"]).toEqual(["fuego", "limpieza"]);
    expect(bySlug["cuadrilla-vial"]).toEqual(["limpieza", "vialidad"]);

    const zones = await pool.query(
      `select a.name from area_responsibilities ar join areas a on a.id = ar.area_id join response_units u on u.id = ar.unit_id
       where u.slug = 'oficina-alumbrado' order by a.name`,
    );
    expect(zones.rows.map((r) => r.name)).toEqual(["CENTRO", "CORDON"]);

    const pos = await pool.query("select slug, st_x(location::geometry) as lon, st_y(location::geometry) as lat, location_updated_at from response_units where location is not null");
    expect(pos.rows).toHaveLength(3);
    for (const p of pos.rows) {
      expect(await locatePoint(pool, p.lon, p.lat)).not.toBeNull();
      expect(p.location_updated_at).toBeNull(); // sin fecha hasta refresh explícito
    }
  });

  it("refresh marca vigentes solo las posiciones de demo; reset borra lo operativo y conserva unidades", async () => {
    const pool = await testDb();
    await seedDemo(pool, "montevideo");
    expect(await refreshDemoPositions(pool, "montevideo")).toBe(3);
    const ev = await pool.query("select count(*)::int as n from events where kind = 'demo_position_refreshed'");
    expect(ev.rows[0].n).toBe(3);

    await pool.query("insert into citizen_sessions (token_hash) values ('x')");
    await resetDemo(pool);
    const left = await pool.query(`select (select count(*) from response_units)::int as units, (select count(*) from internal_users)::int as users,
      (select count(*) from citizen_sessions)::int as sessions, (select count(*) from problem_types)::int as types,
      (select count(*) from response_units where location_updated_at is not null)::int as fresh`);
    expect(left.rows[0]).toEqual({ units: 4, users: 5, sessions: 0, types: 10, fresh: 0 });
  });
});

describe("contrato de órdenes", () => {
  it("solo ofrece acciones válidas por estado, actor y bloqueo de revisión", () => {
    expect(allowedActions("offered", "unit", false)).toEqual(["accept", "reject"]);
    expect(allowedActions("accepted", "unit", true)).toEqual(["reject"]);
    expect(allowedActions("in_progress", "operator", false)).toEqual(["complete", "cancel"]);
    expect(allowedActions("completed", "unit", false)).toEqual([]);
  });
});
