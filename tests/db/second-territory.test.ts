import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { refreshDemoPositions, seedDemo } from "../../seeds/demo";
import { policies } from "../../seeds/policies";
import { demoB, seedTerritoryDemoB } from "../../seeds/territory-demo-b";
import { getActiveCatalog } from "@/server/config/catalog";
import { getActivePolicy } from "@/server/config/policies";
import { withTx } from "@/server/db/tx";
import { geocode } from "@/server/geo/geocoder";
import { locatePoint } from "@/server/geo/locate";
import { appendCitizenMessage, createDraft, setLocation } from "@/server/intake/drafts";
import { confirmReport } from "@/server/intake/confirm";
import { getTerritoryView } from "@/server/intake/view";
import { handlers } from "@/server/jobs/handlers";
import { runOnce } from "@/server/jobs/worker-loop";
import { newSession, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

const INSIDE_B = { lon: 0.006, lat: 0.003 };
const PLAZA_INDEPENDENCIA = { lon: -56.1993, lat: -34.9068 };

/**
 * Contrato para el snapshot de `runPlan` (todavía no existe código de producción que elija unidades): las
 * candidatas de un territorio se filtran por `territory_id`, nunca por cercanía. Ver la nota del segundo territorio.
 */
const unitsOf = async (territory: string) =>
  (await (await testDb()).query<{ slug: string }>("select slug from response_units where territory_id = $1 and status = 'enabled' order by slug", [territory])).rows.map((r) => r.slug);

describe("segundo territorio (Montevideo es configuración)", () => {
  let mvd: string;
  let b: string;

  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    await seedDemo(pool, "montevideo");
    b = (await seedTerritoryDemoB(pool)).territoryId;
    mvd = await territoryId(pool);
  });

  it("un punto dentro del cuadrado se localiza en demo-b y no en Montevideo, y viceversa", async () => {
    const pool = await testDb();
    expect(await locatePoint(pool, INSIDE_B.lon, INSIDE_B.lat)).toMatchObject({ territorySlug: "demo-b", territoryId: b, areaName: demoB.area.name });
    expect(await locatePoint(pool, PLAZA_INDEPENDENCIA.lon, PLAZA_INDEPENDENCIA.lat)).toMatchObject({ territorySlug: "montevideo", territoryId: mvd });
    expect(await locatePoint(pool, 0.02, 0.02)).toBeNull();
  });

  it("políticas y catálogo se leen por territorio", async () => {
    const pool = await testDb();
    // Montevideo se compara con el seed, no con un número: el test es sobre el borde entre territorios.
    expect(policies.grouping.radius_m).not.toBe(75);
    expect(policies.textgen.enabled).toBe(true);
    expect((await getActivePolicy(pool, b, "grouping")).config.radius_m).toBe(75);
    expect((await getActivePolicy(pool, mvd, "grouping")).config.radius_m).toBe(policies.grouping.radius_m);
    expect((await getActivePolicy(pool, b, "textgen")).config.enabled).toBe(false);
    expect((await getActivePolicy(pool, mvd, "textgen")).config.enabled).toBe(true);

    const catB = await getActiveCatalog(pool, b);
    const catMvd = await getActiveCatalog(pool, mvd);
    expect(catB.types.map((t) => t.slug).sort()).toEqual(["bache", "basura_acumulada"]);
    expect(catMvd.types.length).toBeGreaterThan(2);
    expect(catB.hash).not.toBe(catMvd.hash);

    expect(await getTerritoryView(pool, { slug: "demo-b" })).toMatchObject({ name: demoB.name, areaLabel: "Sector", zoom: 15 });
  });

  it("el geocodificador de demo-b usa su sufijo y su cuadrado, no los de Montevideo", async () => {
    const pool = await testDb();
    const urls: URL[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(new URL(u));
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const policy = (await getActivePolicy(pool, b, "intake")).config.geocoder;
    expect(await geocode(pool, { query: "Calle 1", territoryId: b, policy, fetchImpl })).toBeNull();
    const p = urls[0].searchParams;
    expect(p.get("q")).toBe("Calle 1, Territorio de prueba B");
    expect(p.get("countrycodes") ?? "").toBe("");
    expect(p.get("bounded")).toBe("1");
    expect(p.get("viewbox")?.split(",").map(Number)).toEqual([0, 0.01, 0.01, 0]);
  });

  it("contrato para runPlan: la unidad de Montevideo sigue en su territorio aunque se mueva dentro de demo-b", async () => {
    const pool = await testDb();
    expect(await unitsOf(b)).toEqual(["cuadrilla-b"]);
    const moved = await pool.query(
      "update response_units set location = st_setsrid(st_makepoint($1, $2), 4326)::geography where territory_id = $3 and slug = 'cuadrilla-limpieza'",
      [INSIDE_B.lon, INSIDE_B.lat, mvd],
    );
    expect(moved.rowCount).toBe(1);
    expect(await locatePoint(pool, INSIDE_B.lon, INSIDE_B.lat)).toMatchObject({ territoryId: b });
    expect(await unitsOf(b)).toEqual(["cuadrilla-b"]);
    expect(await unitsOf(mvd)).toContain("cuadrilla-limpieza");
  });

  it("un reporte en demo-b recorre el pipeline y crea el incidente en demo-b con su área", async () => {
    const pool = await testDb();
    const s = await newSession(pool);
    const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: b }), pool);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-demo-b-1", body: "Hay un pozo grande en la calle" }), pool);
    await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...INSIDE_B, source: "map" }), pool);
    await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-demo-b-01" }), pool);

    expect(await runOnce(testDeps(pool), handlers, { workerId: "test" })).toBe(true);
    const inc = await pool.query(
      `select i.territory_id, a.name as area from incidents i join report_incident_links l on l.incident_id = i.id
       left join areas a on a.id = i.area_id where l.report_id = $1`,
      [id],
    );
    expect(inc.rows).toEqual([{ territory_id: b, area: demoB.area.name }]);
    // El worker leyó las políticas de demo-b: evaluación y agrupación citan versiones de demo-b.
    const used = await pool.query<{ step: string; territory_id: string }>(
      `select 'evaluation' as step, pv.territory_id from report_evaluations e join policy_versions pv on pv.id = e.policy_version_id where e.report_id = $1
       union all
       select 'grouping', pv.territory_id from grouping_decisions g join policy_versions pv on pv.id = g.policy_version_id where g.report_id = $1
       order by step`,
      [id],
    );
    expect(used.rows).toEqual([{ step: "evaluation", territory_id: b }, { step: "grouping", territory_id: b }]);
  });

  it("seedAll de producción no crea demo-b", async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool, { importAreas: false });
    expect((await pool.query("select slug from territories")).rows).toEqual([{ slug: "montevideo" }]);
  });

  it("reseedear demo-b es idempotente", async () => {
    const pool = await testDb();
    await seedTerritoryDemoB(pool);
    const n = await pool.query(`select (select count(*) from response_units where territory_id = $1)::int as units,
      (select count(*) from policy_versions where territory_id = $1)::int as policies, (select count(*) from areas where territory_id = $1)::int as areas,
      (select count(*) from territory_problem_types where territory_id = $1 and enabled)::int as types,
      (select count(*) from unit_capabilities uc join response_units u on u.id = uc.unit_id where u.territory_id = $1)::int as caps,
      (select count(*) from events e join response_units u on u.id = e.entity_id where u.territory_id = $1 and e.kind = 'demo_seeded')::int as seeded`, [b]);
    expect(n.rows[0]).toEqual({
      units: 1, policies: Object.keys(demoB.policies).length, areas: 1,
      types: demoB.problemTypes.length, caps: demoB.unit.capabilities.length, seeded: 1,
    });
  });

  it("reseedear tras cambiar la config publica una versión nueva y conserva la anterior", async () => {
    const pool = await testDb();
    const v1 = await getActivePolicy(pool, b, "grouping");
    await seedTerritoryDemoB(pool, { policies: { ...demoB.policies, grouping: { ...demoB.policies.grouping, radius_m: 120 } } });

    const v2 = await getActivePolicy(pool, b, "grouping");
    expect(v2).toMatchObject({ version: v1.version + 1, config: { radius_m: 120 } });
    // La versión anterior no se edita: lo ya calculado con ella sigue siendo trazable.
    const old = await pool.query("select config->>'radius_m' as radius, active from policy_versions where id = $1", [v1.id]);
    expect(old.rows).toEqual([{ radius: "75", active: false }]);
    // Los kinds sin cambios no se versionan.
    expect((await getActivePolicy(pool, b, "textgen")).version).toBe(1);

    await seedTerritoryDemoB(pool);
    expect((await getActivePolicy(pool, b, "grouping")).config.radius_m).toBe(75);
    expect(await activeCounts(b)).toEqual(Object.fromEntries(Object.keys(demoB.policies).map((k) => [k, 1])));
  });

  it("reseedear converge territorio, área, catálogo y unidad al archivo", async () => {
    const pool = await testDb();
    const unitState = async () =>
      (await pool.query(
        `select st_x(location::geometry) as lon, location_updated_at, array(select cap.slug from unit_capabilities uc
           join capabilities cap on cap.id = uc.capability_id where uc.unit_id = u.id order by cap.slug) as caps
         from response_units u where territory_id = $1`,
        [b],
      )).rows;
    expect(await unitState()).toEqual([{ lon: demoB.unit.position.lon, location_updated_at: null, caps: ["limpieza", "vialidad"] }]);
    await refreshDemoPositions(pool, "demo-b");
    await pool.query("update territories set enabled = false where id = $1", [b]);

    await seedTerritoryDemoB(pool, {
      defaultZoom: 14,
      square: { minLon: 0, minLat: 0, maxLon: 0.02, maxLat: 0.02 },
      problemTypes: ["bache"],
      unit: { ...demoB.unit, capabilities: ["vialidad"], position: { lon: 0.015, lat: 0.015 } },
    });
    expect(await getTerritoryView(pool, { slug: "demo-b" })).toMatchObject({ zoom: 14 });
    expect(await locatePoint(pool, 0.015, 0.015)).toMatchObject({ territoryId: b, areaName: demoB.area.name });
    expect((await getActiveCatalog(pool, b)).types.map((t) => t.slug)).toEqual(["bache"]);
    // La posición cambió: la fecha de la anterior no vale para la nueva.
    expect(await unitState()).toEqual([{ lon: 0.015, location_updated_at: null, caps: ["vialidad"] }]);

    await seedTerritoryDemoB(pool);
    expect((await getActiveCatalog(pool, b)).types.map((t) => t.slug).sort()).toEqual(["bache", "basura_acumulada"]);
    expect(await locatePoint(pool, 0.015, 0.015)).toBeNull();
    expect(await unitState()).toEqual([{ lon: demoB.unit.position.lon, location_updated_at: null, caps: ["limpieza", "vialidad"] }]);
    const seeded = await pool.query("select count(*)::int as n from events where kind = 'demo_seeded' and entity_id = (select id from response_units where territory_id = $1)", [b]);
    expect(seeded.rows[0].n).toBe(1);
    // Con la misma posición, reseedear no le quita la vigencia.
    await refreshDemoPositions(pool, "demo-b");
    await seedTerritoryDemoB(pool);
    expect((await unitState())[0].location_updated_at).not.toBeNull();
  });

  it("reseedear con la versión 1 inactiva deja una versión activa con la config del seed", async () => {
    const pool = await testDb();
    await pool.query("update policy_versions set active = false where territory_id = $1", [b]);
    await seedTerritoryDemoB(pool);
    expect(await activeCounts(b)).toEqual(Object.fromEntries(Object.keys(demoB.policies).map((k) => [k, 1])));
    expect(await getActivePolicy(pool, b, "grouping")).toMatchObject({ version: 2, config: { radius_m: 75 } });
  });
});

/** Versiones activas por kind de un territorio. */
async function activeCounts(territory: string): Promise<Record<string, number>> {
  const { rows } = await (await testDb()).query<{ kind: string; n: number }>(
    "select kind, count(*) filter (where active)::int as n from policy_versions where territory_id = $1 group by kind",
    [territory],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}
