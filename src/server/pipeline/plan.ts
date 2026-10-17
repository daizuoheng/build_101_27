import type { Pool, PoolClient } from "pg";
import type { Db } from "../db/pool";
import { withTx } from "../db/tx";
import { getActivePolicy } from "../config/policies";
import { appendEvent } from "../events/append";
import { enqueue, type Job } from "../jobs/queue";
import { computePriority } from "./priority";
import type { BuildPlan, DispatchStrategy, PlanIncident, PlanPolicy, PlanSnapshot, PlanUnit, PriorityBand } from "@/shared/contracts/plan";

const OPEN = ["open", "assigned", "in_progress"];
const ACTIVE_ORDERS = ["offered", "accepted", "in_progress"];
const DEFERRED = "%:deferred:%"; // clave de los jobs `plan` diferidos (`deferPlan`)

/**
 * Snapshot del territorio para `buildPlan`, todo desde la base y con un único instante `now`.
 * La banda se recalcula con la hora actual (promoción por antigüedad) salvo que haya una banda corregida a mano.
 */
export async function buildSnapshot(db: Db, territoryId: string, now: Date): Promise<{ snapshot: PlanSnapshot; policy: PlanPolicy; policyVersionId: string; policyVersions: Record<string, string>; bands: Record<string, PriorityBand>; revisions: Record<string, number> }> {
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
      // Sin tipo no hay capacidades requeridas: no se despacha a cualquier unidad hasta que alguien lo clasifique.
      dispatchBlocked: r.dispatch_blocked || r.problem_type_id === null, problemTypeId: r.problem_type_id, requiredCapabilities: r.required,
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
    policyVersions: { planning: planning.id, dispatch: dispatch.id, priority: priority.id },
    bands: Object.fromEntries(incidents.map((i) => [i.id, i.band])),
    revisions: Object.fromEntries(incidents.map((i) => [i.id, i.revision])),
  };
}

/**
 * Una sola corrida de plan por territorio a la vez. Clave de dos enteros: no se pisa con el lock del territorio (clave única).
 * `wait` espera a la corrida en curso; `try` devuelve false si hay una.
 */
async function planLock(c: PoolClient, territoryId: string, mode: "wait" | "try"): Promise<boolean> {
  if (mode === "wait") {
    await c.query("select pg_advisory_xact_lock(hashtext('plan'), hashtext($1))", [territoryId]);
    return true;
  }
  const { rows } = await c.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext('plan'), hashtext($1)) as ok", [territoryId]);
  return rows[0].ok;
}

/**
 * `RunPlan` de src/server/contracts.ts, entrada directa: snapshot → `buildPlan` (puro, de Operación) → plan_runs/plan_items.
 * Los ítems del plan anterior que no se ejecutaron quedan `obsolete`. Encola `dispatch` si hay propuestas.
 * Si hay otra corrida del territorio en curso, la espera (el job `plan` en cambio se difiere: ver `planHandler`).
 */
export async function runPlan(
  pool: Pool,
  input: { territoryId: string; trigger: string; jobId?: string },
  deps: { buildPlan: BuildPlan; now?: () => Date },
): Promise<{ planRunId: string; coalesced: number }> {
  return withTx(async (c) => {
    await planLock(c, input.territoryId, "wait");
    return planInTx(c, input, deps);
  }, pool);
}

async function planInTx(
  c: PoolClient,
  input: { territoryId: string; trigger: string; jobId?: string },
  deps: { buildPlan: BuildPlan; now?: () => Date },
): Promise<{ planRunId: string; coalesced: number }> {
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [input.territoryId]); // mismo lock que los escritores de incidentes
  // Pedidos pendientes y vencidos del territorio: esta corrida los cubre. En la misma transacción: si falla, vuelven a pendientes.
  // Un job diferido pendiente también, aunque no haya vencido o sea más nuevo que este: los pedidos que junta ya estaban
  // confirmados antes de que esta sentencia lo viera, así que el snapshot de abajo los cubre (`deferPlan`).
  const coalesced = input.jobId
    ? (await c.query(
        `update jobs set status = 'done', last_error = 'coalesced:' || $2, updated_at = now()
         where kind = 'plan' and entity_id = $1 and status = 'pending' and id <> $2
           and ((run_after <= now() and created_at <= (select created_at from jobs where id = $2)) or dedupe_key like $3)`,
        [input.territoryId, input.jobId, DEFERRED],
      )).rowCount ?? 0
    : 0;
  const trigger = coalesced ? `${input.trigger}+${coalesced}` : input.trigger;
  // Un único instante, del reloj de la base (no del worker): ordena bien los planes aunque haya varios workers.
  const now = deps.now?.() ?? (await c.query<{ now: Date }>("select now() as now")).rows[0].now;
  const { snapshot, policy, policyVersionId, policyVersions, bands, revisions } = await buildSnapshot(c, input.territoryId, now);
  const result = deps.buildPlan(snapshot, policy, now);

  const run = await c.query<{ id: string }>(
    `insert into plan_runs (territory_id, policy_version_id, computed_at, trigger, snapshot_refs, stats)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [input.territoryId, policyVersionId, now, trigger, JSON.stringify({ incident_revisions: revisions, units: snapshot.units.map((u) => u.id), policy_versions: policyVersions }),
      JSON.stringify({ incidents: snapshot.incidents.length, units: snapshot.units.length, proposals: result.proposals.length, pending: result.pending.length })],
  );
  const planRunId = run.rows[0].id;
  await c.query(
    `update plan_items pi set status = 'obsolete' from plan_runs pr
     where pr.id = pi.plan_run_id and pr.territory_id = $1 and pr.id <> $2 and pi.status in ('proposed', 'queued', 'blocked')`,
    [input.territoryId, planRunId],
  );
  // Un despacho pendiente de un plan anterior ya no corresponde: este plan lo reemplaza.
  await c.query(
    `update jobs set status = 'done', last_error = 'superseded_by:' || $2, updated_at = now()
     where kind = 'dispatch' and territory_id = $1 and status = 'pending'`,
    [input.territoryId, planRunId],
  );
  // La banda con la que se ordenó (promoción por antigüedad) queda también en el incidente, para que la vista coincida.
  await c.query(
    `update incidents i set priority_band = b.band from unnest($1::uuid[], $2::text[]) as b(id, band)
     where i.id = b.id and i.priority_band <> b.band`,
    [Object.keys(bands), Object.values(bands)],
  );
  for (const q of result.queue) {
    // Un incidente ya asignado no está bloqueado: sigue en la cola con su orden activa.
    const assigned = q.pendingReasons.includes("active_assignment");
    const status = q.proposal ? "proposed" : q.pendingReasons.length && !assigned ? "blocked" : "queued";
    await c.query(
      `insert into plan_items (plan_run_id, incident_id, position, proposed_unit_id, score_breakdown, reasons, status, blocked_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [planRunId, q.incidentId, q.position, q.proposal?.unitId ?? null,
        JSON.stringify({ ...q.score, band: q.band, activeHazard: q.activeHazard, distanceM: q.proposal?.distanceM ?? null }),
        JSON.stringify(q.proposal ? q.proposal.reasons : q.pendingReasons), status, q.proposal ? null : (q.pendingReasons[0] ?? null)],
    );
  }
  await appendEvent(c, { entityType: "territory", entityId: input.territoryId, kind: "plan_computed", actorType: "system", data: { plan_run_id: planRunId, trigger, proposals: result.proposals.length } });
  if (result.proposals.length) {
    await enqueue(c, { kind: "dispatch", entityType: "plan_run", entityId: planRunId, entityRevision: 0, territoryId: input.territoryId, payload: { plan_run_id: planRunId } });
  }
  return { planRunId, coalesced };
}

/**
 * Otra corrida del territorio está en curso y su snapshot puede ser anterior a este pedido: en vez de calcular un plan
 * que esa corrida va a pisar, el pedido pasa a un job `plan` diferido, que arranca recién a los `busy_retry_sec` segundos
 * y toma su snapshot después de este pedido.
 * - Si ya hay uno pendiente sin intentos fallidos, se reutiliza: se bloquea su fila hasta el commit, así ningún worker
 *   lo reclama ni lo junta antes de que este pedido quede confirmado.
 * - Si no hay, o su fila está bloqueada (una corrida juntándolo, un worker reclamándolo u otro pedido difiriéndose),
 *   se crea uno con la clave del job que difiere, sin esperar. En el peor caso queda un job de más, que la corrida
 *   siguiente junta.
 * - Si esa clave ya existía (un intento anterior de este mismo job), ese job se creó después del evento de este pedido:
 *   en cualquier estado lo cubre.
 * Lleva el disparador del primer pedido diferido (`deferred:<disparador>`).
 */
async function deferPlan(c: PoolClient, territoryId: string, jobId: string, trigger: string): Promise<string> {
  const pending = await c.query<{ id: string }>(
    `select id from jobs where kind = 'plan' and entity_id = $1 and status = 'pending' and attempts = 0 and dedupe_key like $2
     order by run_after limit 1 for update skip locked`,
    [territoryId, DEFERRED],
  );
  if (pending.rows[0]) return pending.rows[0].id;
  const { busy_retry_sec } = (await getActivePolicy(c, territoryId, "planning")).config;
  const runAfter = (await c.query<{ t: Date }>("select clock_timestamp() + make_interval(secs => $1) as t", [busy_retry_sec])).rows[0].t;
  const job = await enqueue(c, {
    kind: "plan", entityType: "territory", entityId: territoryId, entityRevision: 0, territoryId,
    payload: { trigger: trigger.startsWith("deferred:") ? trigger : `deferred:${trigger}` }, runAfter, dedupeSuffix: `deferred:${jobId}`,
  });
  return job.id;
}

/**
 * Handler del job `plan`. Junta los pedidos pendientes del mismo territorio: una corrida cubre todos los eventos
 * anteriores a ella, así no se recalcula una vez por evento redundante. Si otro worker ya está calculando el plan
 * del territorio, no calcula otro en paralelo: difiere el pedido (`deferPlan`).
 */
export function planHandler(buildPlan: BuildPlan): { run: (deps: { pool: Pool }, job: Job) => Promise<void> } {
  return {
    run: async (deps, job) => {
      const territoryId = job.territory_id ?? job.entity_id;
      const trigger = String((job.payload as { trigger?: string; reason?: string }).trigger ?? job.payload?.reason ?? "event");
      await withTx(async (c) => {
        if (await planLock(c, territoryId, "try")) await planInTx(c, { territoryId, trigger, jobId: job.id }, { buildPlan });
        else await deferPlan(c, territoryId, job.id, trigger);
      }, deps.pool);
    },
  };
}

/**
 * Replanificación periódica (factores temporales: antigüedad, ventana, vigencia de posiciones). Un job por intervalo.
 * Si el del intervalo falló, no se revive: el worker llama cada minuto y lo reintentaría sin límite; lo cubre el intervalo siguiente.
 */
export async function enqueuePeriodicPlans(pool: Pool, now = new Date()): Promise<number> {
  const terr = await pool.query<{ id: string; config: { replan_interval_min: number } }>(
    `select t.id, pv.config from territories t join policy_versions pv on pv.territory_id = t.id and pv.kind = 'planning' and pv.active where t.enabled`,
  );
  let n = 0;
  for (const t of terr.rows) {
    const bucket = Math.floor(now.getTime() / (t.config.replan_interval_min * 60_000));
    const r = await enqueue(pool, { kind: "plan", entityType: "territory", entityId: t.id, entityRevision: 0, territoryId: t.id, payload: { trigger: "periodic" }, dedupeSuffix: `periodic:${bucket}`, reviveFailed: false });
    if (r.created) n++;
  }
  return n;
}
