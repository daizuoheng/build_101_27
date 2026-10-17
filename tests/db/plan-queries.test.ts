import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { getLatestPlan, requestReplan } from "@/server/planning/queries";
import { territoryId } from "./fakes";
import { resetDb, testDb } from "./setup";

const OPERATOR = "00000000-0000-4000-8000-0000000000aa";

async function insertIncident(pool: Awaited<ReturnType<typeof testDb>>, t: string, over: { title?: string; band?: string } = {}) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into incidents (territory_id, location, title, priority_band)
     values ($1, st_setsrid(st_makepoint(-56.19, -34.90), 4326)::geography, $2, $3) returning id`,
    [t, over.title ?? null, over.band ?? "medium"],
  );
  return rows[0].id;
}

async function insertUnit(pool: Awaited<ReturnType<typeof testDb>>, t: string, slug: string) {
  const { rows } = await pool.query<{ id: string }>(
    "insert into response_units (territory_id, slug, name, unit_kind, capacity) values ($1, $2, $3, 'mobile_crew', 1) returning id",
    [t, slug, `Unidad ${slug}`],
  );
  return rows[0].id;
}

async function insertRun(pool: Awaited<ReturnType<typeof testDb>>, t: string, computedAt: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into plan_runs (territory_id, policy_version_id, computed_at, trigger)
     select $1, id, $2, 'manual' from policy_versions where territory_id = $1 and kind = 'planning' and active returning id`,
    [t, computedAt],
  );
  return rows[0].id;
}

describe("lectura del plan y pedido de recálculo", () => {
  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
  });

  it("sin plan calculado devuelve planRun null y sin ítems", async () => {
    const pool = await testDb();
    expect(await getLatestPlan(pool, await territoryId(pool))).toEqual({ planRun: null, items: [] });
  });

  it("devuelve el último plan en orden, con propuesta, orden activa y desglose persistido", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    const a = await insertIncident(pool, t, { title: "Bache en Minas", band: "high" });
    const b = await insertIncident(pool, t, { band: "low" });
    const u1 = await insertUnit(pool, t, "u1");
    const u2 = await insertUnit(pool, t, "u2");

    const old = await insertRun(pool, t, "2026-10-17T10:00:00Z");
    await pool.query("insert into plan_items (plan_run_id, incident_id, position, status) values ($1, $2, 1, 'obsolete')", [old, a]);

    const run = await insertRun(pool, t, "2026-10-17T11:00:00Z");
    await pool.query(
      `insert into plan_items (plan_run_id, incident_id, position, proposed_unit_id, score_breakdown, reasons, status, blocked_reason) values
       ($1, $2, 2, null, '{"waitHours":6,"sources":1,"bonusHours":0,"score":6}', '[]', 'blocked', 'no_capacity'),
       ($1, $3, 1, $4, '{"waitHours":3,"sources":4,"bonusHours":4,"score":7}', '["nearest_mobile"]', 'executed', null)`,
      [run, b, a, u1],
    );
    await pool.query("insert into assignments (incident_id, unit_id, status) values ($1, $2, 'accepted')", [a, u2]);

    const res = await getLatestPlan(pool, t);
    expect(res.planRun).toMatchObject({ id: run, trigger: "manual", policyVersion: expect.any(Number) });
    expect(res.items.map((i) => i.position)).toEqual([1, 2]);
    expect(res.items[0]).toMatchObject({
      incident: { id: a, title: "Bache en Minas", priorityBand: "high", activeHazard: false, status: "open" },
      score: { waitHours: 3, sources: 4, bonusHours: 4, score: 7 },
      proposedUnit: { id: u1, name: "Unidad u1" },
      assignedUnit: { id: u2, name: "Unidad u2", status: "accepted" },
      status: "executed",
      reasons: ["nearest_mobile"],
      blockedReason: null,
    });
    expect(res.items[1]).toMatchObject({ incident: { id: b, title: "Incidente" }, proposedUnit: null, assignedUnit: null, status: "blocked", blockedReason: "no_capacity" });
  });

  it("«Actualizar plan» encola un job plan del territorio y reutiliza el pendiente ante clics repetidos", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    const [first, second] = await Promise.all([requestReplan(pool, { territoryId: t, actorId: OPERATOR }), requestReplan(pool, { territoryId: t, actorId: OPERATOR })]);
    expect(second.jobId).toBe(first.jobId);
    expect([first.created, second.created].sort()).toEqual([false, true]);

    const jobs = await pool.query("select kind, entity_type, entity_id, territory_id, status, payload from jobs");
    expect(jobs.rows).toEqual([{ kind: "plan", entity_type: "territory", entity_id: t, territory_id: t, status: "pending", payload: { trigger: "manual" } }]);
    const ev = await pool.query("select kind, actor_type, actor_id from events where entity_type = 'territory'");
    expect(ev.rows).toEqual([{ kind: "plan_requested", actor_type: "operator", actor_id: OPERATOR }]);

    // dedupe_key estable: un job terminado colapsa a la misma clave; el ON CONFLICT no revive un `done`,
    // así que un nuevo pedido reutiliza el mismo job (mismo id) en vez de duplicarlo.
    await pool.query("update jobs set status = 'done'");
    const third = await requestReplan(pool, { territoryId: t, actorId: OPERATOR });
    expect(third.jobId).toBe(first.jobId);
    const afterThird = await pool.query("select count(*)::int as n from jobs where kind = 'plan'");
    expect(afterThird.rows[0].n).toBe(1);

    // Un job `failed` se revive con la misma clave (ON CONFLICT revive-failed) y vuelve a quedar pendiente,
    // sin crear un job nuevo.
    await pool.query("update jobs set status = 'failed'");
    const fourth = await requestReplan(pool, { territoryId: t, actorId: OPERATOR });
    expect(fourth.jobId).toBe(first.jobId);
    const revived = await pool.query<{ status: string; n: number }>(
      "select status, (select count(*)::int from jobs where kind = 'plan') as n from jobs where id = $1",
      [fourth.jobId],
    );
    expect(revived.rows[0].status).toBe("pending");
    expect(revived.rows[0].n).toBe(1);
  });
});
