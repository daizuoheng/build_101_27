// Job `plan` de Núcleo. `buildPlan` es de Operación (src/server/planning, PR #11); acá se usa un planificador
// de PRUEBA claramente simulado (propone la primera unidad capaz) solo para verificar snapshot y persistencia.
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { seedAll } from "../../seeds";
import { seedDemo } from "../../seeds/demo";
import { buildSnapshot, enqueuePeriodicPlans, planHandler, runPlan } from "@/server/pipeline/plan";
import { enqueue } from "@/server/jobs/queue";
import type { BuildPlan } from "@/shared/contracts/plan";
import { resetDb, testDb } from "./setup";
import { territoryId } from "./fakes";

const testPlanner: BuildPlan = (snapshot) => {
  const queue = snapshot.incidents.map((i, idx) => {
    const unit = i.dispatchBlocked ? null : snapshot.units.find((u) => i.requiredCapabilities.every((c) => u.capabilities.includes(c)) && u.activeOrders < u.capacity);
    return {
      incidentId: i.id, position: idx + 1, band: i.band, activeHazard: i.activeHazard,
      score: { waitHours: 1, sources: i.sourcesInWindow, bonusHours: 0, score: 1 },
      proposal: unit ? { incidentId: i.id, unitId: unit.id, distanceM: 10, reasons: ["nearest_mobile" as const] } : null,
      pendingReasons: unit ? [] : [i.dispatchBlocked ? ("dispatch_blocked" as const) : ("no_capable_unit" as const)],
    };
  });
  return { queue, proposals: queue.flatMap((q) => (q.proposal ? [q.proposal] : [])), pending: queue.filter((q) => !q.proposal).map((q) => ({ incidentId: q.incidentId, reasons: q.pendingReasons })) };
};

const one = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

async function incident(pool: Pool, t: string, over: { slug: string; hazard?: boolean; severity?: string; hoursAgo?: number; blocked?: boolean; areaExt?: string }) {
  return (await one(
    pool,
    `insert into incidents (territory_id, problem_type_id, location, severity, active_hazard, dispatch_blocked, created_at, area_id, priority_band)
     select $1, pt.id, st_setsrid(st_makepoint(-56.1993, -34.9068), 4326)::geography, $3, $4, $5, now() - make_interval(hours => $6),
       (select id from areas where territory_id = $1 and external_id = $7), 'low'
     from problem_types pt where pt.slug = $2 returning id`,
    [t, over.slug, over.severity ?? "low", over.hazard ?? false, over.blocked ?? false, over.hoursAgo ?? 1, over.areaExt ?? "52"],
  )).id as string;
}

describe("job plan", () => {
  let pool: Pool;
  let t: string;
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    await seedDemo(pool, "montevideo");
    t = await territoryId(pool);
  });

  it("arma el snapshot desde la base: capacidades requeridas (con peligro activo), fuentes, estrategias y unidades", async () => {
    const fuego = await incident(pool, t, { slug: "contenedor_danado", hazard: true });
    const viejo = await incident(pool, t, { slug: "bache", severity: "low", hoursAgo: 50 });
    const now = new Date();
    const { snapshot, policy } = await buildSnapshot(pool, t, now);

    const f = snapshot.incidents.find((i) => i.id === fuego)!;
    expect(f.requiredCapabilities).toEqual(["fuego", "limpieza"]); // limpieza siempre + fuego por peligro activo
    expect(f.band).toBe("high");
    const v = snapshot.incidents.find((i) => i.id === viejo)!;
    expect(v.band).toBe("medium"); // baja con más de 48 h: promovida al planificar, con la hora actual
    expect(v.requiredCapabilities).toEqual(["vialidad"]);

    expect(snapshot.units).toHaveLength(4);
    const oficina = snapshot.units.find((u) => u.kind === "zone_office")!;
    expect(oficina.location).toBeNull();
    expect(oficina.zoneResponsibilities).toHaveLength(2);
    const alumbrado = (await one(pool, "select id from problem_types where slug = 'alumbrado'")).id;
    expect(snapshot.strategies[alumbrado]).toBe("zone_owner");
    expect(snapshot.defaultStrategy).toBe("nearest_mobile");
    expect(policy).toMatchObject({ window_hours: 24, weight_hours: 2, cap_hours: 12, max_distance_m: 3000, position_max_age_min: 30 });
  });

  it("una banda promovida por antigüedad actualiza el desglose, invalida la explicación de prioridad y reencola textgen", async () => {
    const viejo = await incident(pool, t, { slug: "bache", severity: "low", hoursAgo: 50 }); // priority_band 'low' en el insert
    await pool.query(
      `insert into generated_texts (purpose, entity_type, entity_id, entity_revision, body) values
         ('explain_priority', 'incident', $1, 1, 'Prioridad baja'), ('title', 'incident', $1, 1, 'Bache')`,
      [viejo],
    );
    await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
    const inc = await one(pool, "select priority_band, priority_breakdown from incidents where id = $1", [viejo]);
    expect(inc.priority_band).toBe("medium");
    expect(inc.priority_breakdown).toMatchObject({ promoted_by_age: true, computed_band: "medium" });
    expect((await pool.query("select purpose from generated_texts where entity_id = $1 order by purpose", [viejo])).rows).toEqual([{ purpose: "title" }]);
    const job = await one(pool, "select entity_revision, dedupe_key from jobs where kind = 'textgen' and entity_id = $1", [viejo]);
    expect(job).toMatchObject({ entity_revision: 1 });
    expect(job.dedupe_key).toMatch(/:band:medium$/);

    // Segunda corrida sin cambio de banda: no borra ni encola de nuevo.
    await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'textgen' and entity_id = $1", [viejo])).n).toBe(1);
  });

  it("guarda el plan, deja obsoleto el anterior y encola dispatch si hay propuestas", async () => {
    const a = await incident(pool, t, { slug: "bache" });
    const b = await incident(pool, t, { slug: "basura_acumulada", blocked: true });
    const first = await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
    const items = await pool.query("select incident_id, status, blocked_reason, proposed_unit_id is not null as proposed, score_breakdown from plan_items where plan_run_id = $1 order by position", [first.planRunId]);
    const byIncident = Object.fromEntries(items.rows.map((r) => [r.incident_id, r]));
    expect(byIncident[a]).toMatchObject({ status: "proposed", blocked_reason: null, proposed: true });
    expect(byIncident[b]).toMatchObject({ status: "blocked", blocked_reason: "dispatch_blocked", proposed: false });
    expect(byIncident[a].score_breakdown).toMatchObject({ waitHours: 1, sources: 0, bonusHours: 0, score: 1 });
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'dispatch' and entity_id = $1", [first.planRunId])).n).toBe(1);

    const second = await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
    expect((await one(pool, "select count(*)::int as n from plan_items where plan_run_id = $1 and status <> 'obsolete'", [first.planRunId])).n).toBe(0);
    expect((await one(pool, "select count(*)::int as n from plan_items where plan_run_id = $1", [second.planRunId])).n).toBe(2);
  });

  it("una corrida junta los pedidos de plan pendientes del territorio", async () => {
    await incident(pool, t, { slug: "bache" });
    for (const s of ["a", "b", "c"]) await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, dedupeSuffix: s });
    const jobs = await pool.query("select * from jobs where kind = 'plan' order by created_at");
    const last = jobs.rows[2];
    await planHandler(testPlanner).run({ pool }, { ...last, territory_id: t, payload: { trigger: "event" } });
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan' and status = 'pending' and id <> $1", [last.id])).n).toBe(0);
    expect((await one(pool, "select trigger from plan_runs")).trigger).toBe("event+2");
  });

  it("un plan nuevo reemplaza el despacho pendiente del anterior, bloquea incidentes sin tipo y deja la banda usada", async () => {
    const sinTipo = (await one(pool, "insert into incidents (territory_id, location, severity) values ($1, st_setsrid(st_makepoint(-56.1993, -34.9068), 4326)::geography, 'high') returning id", [t])).id;
    const viejo = await incident(pool, t, { slug: "bache", severity: "low", hoursAgo: 50 });
    const first = await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
    const second = await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
    expect((await one(pool, "select status, last_error from jobs where kind = 'dispatch' and entity_id = $1", [first.planRunId]))).toEqual({ status: "done", last_error: `superseded_by:${second.planRunId}` });
    expect((await one(pool, "select status from jobs where kind = 'dispatch' and entity_id = $1", [second.planRunId])).status).toBe("pending");
    expect((await one(pool, "select status, blocked_reason from plan_items where plan_run_id = $1 and incident_id = $2", [second.planRunId, sinTipo]))).toEqual({ status: "blocked", blocked_reason: "dispatch_blocked" });
    expect((await one(pool, "select priority_band from incidents where id = $1", [viejo])).priority_band).toBe("medium");
    expect((await one(pool, "select snapshot_refs from plan_runs where id = $1", [second.planRunId])).snapshot_refs.policy_versions).toEqual(expect.objectContaining({ planning: expect.any(String), dispatch: expect.any(String), priority: expect.any(String) }));
  });

  it("si la corrida falla, los pedidos juntados vuelven a quedar pendientes", async () => {
    await incident(pool, t, { slug: "bache" });
    for (const s of ["a", "b"]) await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, dedupeSuffix: s });
    const last = (await pool.query("select * from jobs where kind = 'plan' order by created_at desc limit 1")).rows[0];
    const broken = () => { throw new Error("planificador roto"); };
    await expect(planHandler(broken as never).run({ pool }, { ...last, territory_id: t, payload: {} })).rejects.toThrow("planificador roto");
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan' and status = 'pending'")).n).toBe(2);
    expect((await one(pool, "select count(*)::int as n from plan_runs")).n).toBe(0);
  });

  it("con otra corrida del territorio en curso no calcula en paralelo: difiere el pedido a un único job, sin perder ninguno", async () => {
    await incident(pool, t, { slug: "bache" });
    for (const s of ["a", "b", "c"]) await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, dedupeSuffix: s });
    const [a, b, c] = (await pool.query("select * from jobs where kind = 'plan' order by created_at")).rows;
    await pool.query("update jobs set status = 'running' where id = any($1)", [[a.id, b.id]]); // reclamados por otros workers

    // Otro worker está calculando el plan del territorio (tiene el lock de plan en su transacción).
    const busy = await pool.connect();
    try {
      await busy.query("begin");
      await busy.query("select pg_advisory_xact_lock(hashtext('plan'), hashtext($1))", [t]);
      await planHandler(testPlanner).run({ pool }, { ...a, territory_id: t, payload: { trigger: "event" } });
      await planHandler(testPlanner).run({ pool }, { ...b, territory_id: t, payload: { trigger: "event" } });
    } finally {
      await busy.query("rollback");
      busy.release();
    }
    expect((await one(pool, "select count(*)::int as n from plan_runs")).n).toBe(0);
    const deferred = await pool.query("select id, status, payload, run_after > now() as later from jobs where kind = 'plan' and dedupe_key like '%:deferred:%'");
    expect(deferred.rows).toHaveLength(1);
    expect(deferred.rows[0]).toMatchObject({ status: "pending", payload: { trigger: "deferred:event" }, later: true });
    expect((await one(pool, "select status from jobs where id = $1", [c.id])).status).toBe("pending"); // el pedido sin reclamar sigue en pie

    // Libre el lock, el job diferido calcula un solo plan que junta el pedido pendiente.
    await pool.query("update jobs set run_after = now(), status = 'running' where id = $1", [deferred.rows[0].id]);
    const job = (await pool.query("select * from jobs where id = $1", [deferred.rows[0].id])).rows[0];
    await planHandler(testPlanner).run({ pool }, job);
    expect((await pool.query("select trigger from plan_runs")).rows).toEqual([{ trigger: "deferred:event+1" }]);
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan' and status = 'pending'")).n).toBe(0);
  });

  it("una corrida junta el job diferido pendiente aunque no haya vencido; un pedido posterior se difiere en uno nuevo", async () => {
    await incident(pool, t, { slug: "bache" });
    for (const s of ["a", "b"]) await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, dedupeSuffix: s });
    const [a, b] = (await pool.query("select * from jobs where kind = 'plan' order by created_at")).rows;
    const deferWhileBusy = async (job: typeof a) => {
      await pool.query("update jobs set status = 'running' where id = $1", [job.id]); // reclamado por un worker
      const busy = await pool.connect();
      try {
        await busy.query("begin");
        await busy.query("select pg_advisory_xact_lock(hashtext('plan'), hashtext($1))", [t]);
        await planHandler(testPlanner).run({ pool }, { ...job, territory_id: t, payload: { trigger: "event" } });
      } finally {
        await busy.query("rollback");
        busy.release();
      }
    };
    await deferWhileBusy(a);
    const first = (await one(pool, "select id, run_after > now() as later from jobs where dedupe_key like '%:deferred:%'"));
    expect(first.later).toBe(true);

    // Otra corrida (el pedido b) arranca antes de que venza el diferido: lo junta en vez de dejarlo para un plan repetido.
    await planHandler(testPlanner).run({ pool }, { ...b, territory_id: t, payload: { trigger: "event" } });
    expect((await one(pool, "select status, last_error from jobs where id = $1", [first.id]))).toEqual({ status: "done", last_error: `coalesced:${b.id}` });
    expect((await one(pool, "select trigger from plan_runs")).trigger).toBe("event+1");

    // Un pedido diferido después no reutiliza el job ya juntado: crea uno nuevo pendiente.
    await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, dedupeSuffix: "c" });
    const c = (await pool.query("select * from jobs where kind = 'plan' and dedupe_key like '%:c'")).rows[0];
    await deferWhileBusy(c);
    const pending = await pool.query("select id from jobs where kind = 'plan' and status = 'pending' and dedupe_key like '%:deferred:%'");
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].id).not.toBe(first.id);
  });

  it("si el job diferido está tomado por una corrida en curso o ya falló un intento, difiere en uno nuevo sin esperar", async () => {
    await incident(pool, t, { slug: "bache" });
    for (const s of ["a", "b"]) await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, dedupeSuffix: s });
    const [a, b] = (await pool.query("select * from jobs where kind = 'plan' order by created_at")).rows;
    const later = new Date(Date.now() + 60_000);
    const d1 = await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, dedupeSuffix: "deferred:x", runAfter: later });
    const d2 = await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t, entityRevision: 0, territoryId: t, dedupeSuffix: "deferred:y", runAfter: later });
    await pool.query("update jobs set attempts = 1 where id = $1", [d2.id]); // en espera tras un intento fallido
    await pool.query("update jobs set status = 'running' where id = any($1)", [[a.id, b.id]]);

    // Una corrida en curso: tiene el lock de plan y ya juntó d1 (sin confirmar todavía).
    const busy = await pool.connect();
    try {
      await busy.query("begin");
      await busy.query("select pg_advisory_xact_lock(hashtext('plan'), hashtext($1))", [t]);
      await busy.query("update jobs set status = 'done' where id = $1", [d1.id]);
      const run = planHandler(testPlanner).run({ pool }, { ...a, territory_id: t, payload: { trigger: "event" } });
      const settled = await Promise.race([run.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
      expect(settled).toBe(true); // no se quedó esperando la fila de d1
    } finally {
      await busy.query("rollback");
      busy.release();
    }
    const fresh = await one(pool, "select id, status from jobs where dedupe_key like $1", [`%:deferred:${a.id}`]);
    expect(fresh.status).toBe("pending");
    expect([d1.id, d2.id]).not.toContain(fresh.id);
  });

  it("una base con la política planning anterior (sin busy_retry_sec) la actualiza el seed como versión nueva", async () => {
    await pool.query("update policy_versions set config = config - 'busy_retry_sec' where territory_id = $1 and kind = 'planning' and active", [t]);
    await expect(runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner })).rejects.toThrow(/busy_retry_sec/);
    await seedAll(pool, { importAreas: false });
    const active = await one(pool, "select version, config from policy_versions where territory_id = $1 and kind = 'planning' and active", [t]);
    expect(active.version).toBe(2);
    expect(active.config.busy_retry_sec).toBe(10);
    expect((await runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner })).planRunId).toEqual(expect.any(String));
  });

  it("runPlan directo espera la corrida en curso en vez de diferirse", async () => {
    await incident(pool, t, { slug: "bache" });
    const busy = await pool.connect();
    let run: Promise<{ planRunId: string }> | undefined;
    try {
      await busy.query("begin");
      await busy.query("select pg_advisory_xact_lock(hashtext('plan'), hashtext($1))", [t]);
      run = runPlan(pool, { territoryId: t, trigger: "test" }, { buildPlan: testPlanner });
      // Espera hasta ver a runPlan bloqueado en el lock de plan (advisory sin conceder).
      for (let i = 0; i < 100; i++) {
        if ((await one(pool, "select count(*)::int as n from pg_locks where locktype = 'advisory' and objsubid = 2 and not granted")).n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await one(pool, "select count(*)::int as n from pg_locks where locktype = 'advisory' and objsubid = 2 and not granted")).n).toBe(1);
      expect((await one(pool, "select count(*)::int as n from plan_runs")).n).toBe(0);
    } finally {
      await busy.query("rollback");
      busy.release();
    }
    expect((await run!).planRunId).toEqual(expect.any(String));
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan'")).n).toBe(0);
  });

  it("la replanificación periódica encola un job por territorio por intervalo", async () => {
    const now = new Date("2026-10-17T22:00:00Z");
    expect(await enqueuePeriodicPlans(pool, now)).toBe(1);
    expect(await enqueuePeriodicPlans(pool, new Date(now.getTime() + 60_000))).toBe(0); // mismo intervalo de 5 min
    expect(await enqueuePeriodicPlans(pool, new Date(now.getTime() + 6 * 60_000))).toBe(1);
  });
});
