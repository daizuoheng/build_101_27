import type { Pool } from "pg";
import type { Db } from "../db/pool";
import { withTx } from "../db/tx";
import { getActivePolicy } from "../config/policies";
import { appendEvent } from "../events/append";
import { enqueue, type Job } from "../jobs/queue";
import { computePriority } from "./priority";
import type { BuildPlan, DispatchStrategy, PlanIncident, PlanPolicy, PlanSnapshot, PlanUnit, PriorityBand } from "@/shared/contracts/plan";

const OPEN = ["open", "assigned", "in_progress"];
const ACTIVE_ORDERS = ["offered", "accepted", "in_progress"];

/**
 * Snapshot del territorio para `buildPlan`, todo desde la base y con un único instante `now`.
 * La banda se recalcula con la hora actual (promoción por antigüedad) salvo que haya una banda corregida a mano.
 */
export async function buildSnapshot(db: Db, territoryId: string, now: Date): Promise<{ snapshot: PlanSnapshot; policy: PlanPolicy; policyVersionId: string; revisions: Record<string, number> }> {
  const planning = await getActivePolicy(db, territoryId, "planning");
  const dispatch = await getActivePolicy(db, territoryId, "dispatch");
  const priority = await getActivePolicy(db, territoryId, "priority");

  const inc = await db.query<{
    id: string; revision: number; priority_band: PriorityBand; priority_breakdown: { band_override?: PriorityBand } | null; active_hazard: boolean;
    created_at: Date; dispatch_blocked: boolean; problem_type_id: string | null; area_id: string | null; lon: number; lat: number;
    severity: "low" | "medium" | "high" | "undetermined"; passage: "total" | "partial" | "none" | "undetermined";
    accessibility: "affected" | "not_affected" | "undetermined"; sources_in_window: number; required: string[];
  }>(
    `select i.id, i.revision, i.priority_band, i.priority_breakdown, i.active_hazard, i.created_at, i.dispatch_blocked, i.problem_type_id,
       i.area_id, st_x(i.location::geometry) as lon, st_y(i.location::geometry) as lat, i.severity, i.passage, i.accessibility,
       (select count(distinct r.citizen_session_id) from report_incident_links l join reports r on r.id = l.report_id
          where l.incident_id = i.id and l.active and r.confirmed_at >= $2::timestamptz - make_interval(hours => $3))::int as sources_in_window,
       coalesce((select array_agg(distinct c.slug order by c.slug) from problem_type_requirements ptr join capabilities c on c.id = ptr.capability_id
          where ptr.problem_type_id = i.problem_type_id and (ptr.condition = 'always' or (ptr.condition = 'active_hazard' and i.active_hazard))), '{}') as required
     from incidents i where i.territory_id = $1 and i.status = any($4) order by i.id`,
    [territoryId, now, planning.config.window_hours, OPEN],
  );
  const incidents: PlanIncident[] = inc.rows.map((r) => {
    const band = r.priority_breakdown?.band_override
      ?? computePriority({ severity: r.severity, activeHazard: r.active_hazard, passage: r.passage, accessibility: r.accessibility }, r.created_at, now, priority.config).band;
    return {
      id: r.id, revision: r.revision, band, activeHazard: r.active_hazard, createdAt: r.created_at, sourcesInWindow: r.sources_in_window,
      dispatchBlocked: r.dispatch_blocked, problemTypeId: r.problem_type_id, requiredCapabilities: r.required,
      location: { lon: r.lon, lat: r.lat }, areaId: r.area_id,
    };
  });

  const units = await db.query<{
    id: string; unit_kind: string; capacity: number; lon: number | null; lat: number | null; location_updated_at: Date | null;
    service_radius_m: number | null; capabilities: string[]; active_orders: number; zones: { areaId: string; problemTypeId: string; precedence: number }[];
  }>(
    `select u.id, u.unit_kind, u.capacity, st_x(u.location::geometry) as lon, st_y(u.location::geometry) as lat, u.location_updated_at, u.service_radius_m,
       coalesce((select array_agg(c.slug order by c.slug) from unit_capabilities uc join capabilities c on c.id = uc.capability_id where uc.unit_id = u.id), '{}') as capabilities,
       (select count(*) from assignments a where a.unit_id = u.id and a.status = any($2))::int as active_orders,
       coalesce((select json_agg(json_build_object('areaId', ar.area_id, 'problemTypeId', ar.problem_type_id, 'precedence', ar.precedence))
          from area_responsibilities ar where ar.unit_id = u.id), '[]') as zones
     from response_units u where u.territory_id = $1 and u.status = 'enabled' order by u.id`,
    [territoryId, ACTIVE_ORDERS],
  );
  const planUnits: PlanUnit[] = units.rows.map((u) => ({
    id: u.id, kind: u.unit_kind, capabilities: u.capabilities, capacity: u.capacity, activeOrders: u.active_orders,
    location: u.lon !== null && u.lat !== null ? { lon: u.lon, lat: u.lat } : null, locationUpdatedAt: u.location_updated_at,
    serviceRadiusM: u.service_radius_m, zoneResponsibilities: u.zones,
  }));

  const active = await db.query<{ incident_id: string; unit_id: string }>(
    `select a.incident_id, a.unit_id from assignments a join incidents i on i.id = a.incident_id
     where i.territory_id = $1 and a.status = any($2) order by a.incident_id`,
    [territoryId, ACTIVE_ORDERS],
  );

  // Estrategias de la política por slug de tipo → por id (el contrato del planificador usa ids).
  const types = await db.query<{ id: string; slug: string }>("select id, slug from problem_types");
  const strategies: Record<string, DispatchStrategy> = {};
  for (const t of types.rows) {
    const s = dispatch.config.strategies[t.slug];
    if (s) strategies[t.id] = s;
  }

  return {
    snapshot: {
      territoryId, incidents, units: planUnits,
      activeAssignments: active.rows.map((a) => ({ incidentId: a.incident_id, unitId: a.unit_id })),
      strategies, defaultStrategy: dispatch.config.default_strategy,
    },
    policy: {
      window_hours: planning.config.window_hours, weight_hours: planning.config.weight_hours, cap_hours: planning.config.cap_hours,
      max_distance_m: dispatch.config.max_distance_m, position_max_age_min: dispatch.config.position_max_age_min,
    },
    policyVersionId: planning.id,
    revisions: Object.fromEntries(incidents.map((i) => [i.id, i.revision])),
  };
}

/**
 * Job `plan` (`RunPlan` de src/server/contracts.ts): snapshot → `buildPlan` (puro, de Operación) → plan_runs/plan_items.
 * Los ítems del plan anterior que no se ejecutaron quedan `obsolete`. Encola `dispatch` si hay propuestas.
 */
export async function runPlan(pool: Pool, input: { territoryId: string; trigger: string }, deps: { buildPlan: BuildPlan; now?: () => Date }): Promise<{ planRunId: string }> {
  return withTx(async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [input.territoryId]); // mismo lock que los escritores de incidentes
    const now = deps.now?.() ?? new Date();
    const { snapshot, policy, policyVersionId, revisions } = await buildSnapshot(c, input.territoryId, now);
    const result = deps.buildPlan(snapshot, policy, now);

    const run = await c.query<{ id: string }>(
      `insert into plan_runs (territory_id, policy_version_id, computed_at, trigger, snapshot_refs, stats)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.territoryId, policyVersionId, now, input.trigger, JSON.stringify({ incident_revisions: revisions, units: snapshot.units.map((u) => u.id) }),
        JSON.stringify({ incidents: snapshot.incidents.length, units: snapshot.units.length, proposals: result.proposals.length, pending: result.pending.length })],
    );
    const planRunId = run.rows[0].id;
    await c.query(
      `update plan_items pi set status = 'obsolete' from plan_runs pr
       where pr.id = pi.plan_run_id and pr.territory_id = $1 and pr.id <> $2 and pi.status in ('proposed', 'queued', 'blocked')`,
      [input.territoryId, planRunId],
    );
    for (const q of result.queue) {
      const status = q.proposal ? "proposed" : q.pendingReasons.length ? "blocked" : "queued";
      await c.query(
        `insert into plan_items (plan_run_id, incident_id, position, proposed_unit_id, score_breakdown, reasons, status, blocked_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [planRunId, q.incidentId, q.position, q.proposal?.unitId ?? null,
          JSON.stringify({ ...q.score, band: q.band, activeHazard: q.activeHazard, distanceM: q.proposal?.distanceM ?? null }),
          JSON.stringify(q.proposal ? q.proposal.reasons : q.pendingReasons), status, q.proposal ? null : (q.pendingReasons[0] ?? null)],
      );
    }
    await appendEvent(c, { entityType: "territory", entityId: input.territoryId, kind: "plan_computed", actorType: "system", data: { plan_run_id: planRunId, trigger: input.trigger, proposals: result.proposals.length } });
    if (result.proposals.length) {
      await enqueue(c, { kind: "dispatch", entityType: "plan_run", entityId: planRunId, entityRevision: 0, territoryId: input.territoryId, payload: { plan_run_id: planRunId } });
    }
    return { planRunId };
  }, pool);
}

/**
 * Handler del job `plan`. Junta los pedidos pendientes del mismo territorio: una corrida cubre todos los eventos
 * anteriores a ella, así no se recalcula una vez por evento redundante.
 */
export function planHandler(buildPlan: BuildPlan) {
  return async (deps: { pool: Pool }, job: Job) => {
    const territoryId = job.territory_id ?? job.entity_id;
    const coalesced = await deps.pool.query<{ id: string }>(
      `update jobs set status = 'done', last_error = 'coalesced:' || $3, updated_at = now()
       where kind = 'plan' and entity_id = $1 and status = 'pending' and id <> $2 and created_at <= (select created_at from jobs where id = $2)
       returning id`,
      [territoryId, job.id, job.id],
    );
    const trigger = String((job.payload as { trigger?: string }).trigger ?? job.payload?.reason ?? "event");
    await runPlan(deps.pool, { territoryId, trigger: coalesced.rows.length ? `${trigger}+${coalesced.rows.length}` : trigger }, { buildPlan });
  };
}

/** Replanificación periódica (factores temporales: antigüedad, ventana, vigencia de posiciones). Un job por intervalo. */
export async function enqueuePeriodicPlans(pool: Pool, now = new Date()): Promise<number> {
  const terr = await pool.query<{ id: string; config: { replan_interval_min: number } }>(
    `select t.id, pv.config from territories t join policy_versions pv on pv.territory_id = t.id and pv.kind = 'planning' and pv.active where t.enabled`,
  );
  let n = 0;
  for (const t of terr.rows) {
    const bucket = Math.floor(now.getTime() / (t.config.replan_interval_min * 60_000));
    const r = await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t.id, entityRevision: 0, territoryId: t.id, payload: { trigger: "periodic" }, dedupeSuffix: `periodic:${bucket}` });
    if (r.created) n++;
  }
  return n;
}
