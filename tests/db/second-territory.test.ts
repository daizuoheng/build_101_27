import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { seedDemo } from "../../seeds/demo";
import { demoB, seedTerritoryDemoB } from "../../seeds/territory-demo-b";
import { getActiveCatalog } from "@/server/config/catalog";
import { getActivePolicy } from "@/server/config/policies";
import { withTx } from "@/server/db/tx";
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

/** Unidades habilitadas candidatas de un territorio: el filtro es por territorio, nunca por cercanía sola. */
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
    expect((await getActivePolicy(pool, b, "grouping")).config.radius_m).toBe(75);
    expect((await getActivePolicy(pool, mvd, "grouping")).config.radius_m).toBe(30);
    expect((await getActivePolicy(pool, b, "textgen")).config.enabled).toBe(false);
    expect((await getActivePolicy(pool, mvd, "textgen")).config.enabled).toBe(true);

    const catB = await getActiveCatalog(pool, b);
    const catMvd = await getActiveCatalog(pool, mvd);
    expect(catB.types.map((t) => t.slug).sort()).toEqual(["bache", "basura_acumulada"]);
    expect(catMvd.types.length).toBeGreaterThan(2);
    expect(catB.hash).not.toBe(catMvd.hash);

    expect(await getTerritoryView(pool, { slug: "demo-b" })).toMatchObject({ name: demoB.name, areaLabel: "Sector", zoom: 15 });
  });

  it("las unidades del territorio no incluyen las de Montevideo, aunque una esté físicamente dentro de demo-b", async () => {
    const pool = await testDb();
    expect(await unitsOf(b)).toEqual(["cuadrilla-b"]);
    expect(await unitsOf(mvd)).not.toContain("cuadrilla-b");
    await pool.query("update response_units set location = st_setsrid(st_makepoint($1, $2), 4326)::geography where slug = 'cuadrilla-limpieza'", [INSIDE_B.lon, INSIDE_B.lat]);
    expect(await unitsOf(b)).toEqual(["cuadrilla-b"]);
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
      (select count(*) from policy_versions where territory_id = $1)::int as policies, (select count(*) from areas where territory_id = $1)::int as areas`, [b]);
    expect(n.rows[0]).toEqual({ units: 1, policies: Object.keys(demoB.policies).length, areas: 1 });
  });
});
