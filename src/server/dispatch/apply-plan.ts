// Despacho transaccional (Tarea 12): convierte las propuestas de un plan en órdenes, en orden de prioridad.
// Diseño §5 paso 7 y ARQUITECTURA «Planificador determinista»: cada propuesta en su propia transacción, con
// FOR UPDATE de ítem, incidente y unidad, y revalidación completa con la hora actual. Una propuesta es solo eso:
// la orden nace acá si todavía es válida. Reintentar nunca duplica (ítem ya ejecutado + índice único parcial).

import type { Pool, PoolClient } from "pg";
import type { ApplyPlan } from "../contracts";
import { getActivePolicy, type DispatchPolicy, type Versioned } from "../config/policies";
import { withTx } from "../db/tx";
import { notFound } from "../errors";
import { appendEvent } from "../events/append";
import { enqueue } from "../jobs/queue";
import { MOBILE_UNIT_KIND } from "@/shared/contracts/plan";

/** Motivo por el que una propuesta no se convirtió en orden (se guarda en `plan_items.blocked_reason`). */
export type SkipReason =
  | "obsolete_plan" // ya hay un plan más nuevo del territorio
  | "revision_changed" // el incidente cambió desde el plan (o el plan no registró su revisión) ⇒ replanificar
  | "incident_closed"
  | "dispatch_blocked"
  | "active_assignment"
  | "unit_unavailable"
  | "no_capacity"
  | "unknown_type"
  | "no_capable_unit"
  | "not_mobile_unit" // la estrategia pasó a `nearest_mobile` y la unidad propuesta no es móvil
  | "manual_strategy"
  | "stale_position"
  | "out_of_radius"
  | "no_zone_owner";

type Outcome = { kind: "created"; assignmentId: string } | { kind: "skipped"; reason: SkipReason } | { kind: "replan" } | { kind: "obsolete" } | { kind: "done" };

type Run = { id: string; territoryId: string; incidentRevisions: Record<string, unknown> };
type Item = { id: string; incidentId: string; unitId: string; reasons: unknown };

export const applyPlan: ApplyPlan = async (pool, planRunId) => {
  const r = await pool.query<{ id: string; territory_id: string; snapshot_refs: { incident_revisions?: Record<string, unknown> } | null }>(
    "select id, territory_id, snapshot_refs from plan_runs where id = $1",
    [planRunId],
  );
  if (!r.rows[0]) throw notFound("Plan inexistente.");
  const run: Run = { id: r.rows[0].id, territoryId: r.rows[0].territory_id, incidentRevisions: r.rows[0].snapshot_refs?.incident_revisions ?? {} };

  const items = (
    await pool.query<{ id: string; incident_id: string; proposed_unit_id: string; reasons: unknown }>(
      `select id, incident_id, proposed_unit_id, reasons from plan_items
       where plan_run_id = $1 and status = 'proposed' and proposed_unit_id is not null order by position`,
      [run.id],
    )
  ).rows.map((x): Item => ({ id: x.id, incidentId: x.incident_id, unitId: x.proposed_unit_id, reasons: x.reasons }));

  const created: string[] = [];
  const skipped: { incidentId: string; reason: string }[] = [];
  if (!items.length) return { created, skipped, stoppedForReplan: false };

  // Las propuestas obsoletas no se envían: solo se ejecuta el último plan del territorio. Atajo antes del loop;
  // `applyOne` lo vuelve a verificar dentro de cada transacción por si otro plan se confirma a mitad de camino.
  if (!(await isLatestRun(pool, run))) {
    await markObsolete(pool, items);
    return { created, skipped: items.map((i) => ({ incidentId: i.incidentId, reason: "obsolete_plan" })), stoppedForReplan: false };
  }

  const policy = await getActivePolicy(pool, run.territoryId, "dispatch");
  for (const [idx, item] of items.entries()) {
    const out = await withTx((c) => applyOne(c, run, item, policy), pool);
    if (out.kind === "obsolete") {
      // Un plan más nuevo se confirmó durante el despacho: lo que falta de este plan ya no se envía.
      await markObsolete(pool, items.slice(idx + 1));
      skipped.push(...items.slice(idx).map((i) => ({ incidentId: i.incidentId, reason: "obsolete_plan" })));
      return { created, skipped, stoppedForReplan: false };
    }
    if (out.kind === "created") created.push(out.assignmentId);
    else if (out.kind === "skipped") skipped.push({ incidentId: item.incidentId, reason: out.reason });
    else if (out.kind === "replan") {
      // Primero el replan: si falla, el reintento del job todavía encuentra las propuestas y lo vuelve a pedir.
      await requestReplan(pool, run);
      // La propuesta ya no vale y el resto de este plan ya no se envía: el plan nuevo las reemplaza. Quedan así a la
      // vista, juntas, para que nadie las cuente como propuestas en camino mientras tanto.
      await withTx(async (c) => {
        await c.query("update plan_items set status = 'blocked', blocked_reason = 'revision_changed' where id = $1 and status = 'proposed'", [item.id]);
        await markObsolete(c, items.slice(idx + 1));
      }, pool);
      skipped.push({ incidentId: item.incidentId, reason: "revision_changed" });
      return { created, skipped, stoppedForReplan: true };
    }
  }
  return { created, skipped, stoppedForReplan: false };
};

/** Propuestas de este plan que ya no se van a enviar. Solo las que siguen `proposed`: otro despacho pudo procesarlas. */
async function markObsolete(db: Pool | PoolClient, items: Item[]) {
  if (!items.length) return;
  await db.query(
    "update plan_items set status = 'obsolete', blocked_reason = 'obsolete_plan' where id = any($1::uuid[]) and status = 'proposed'",
    [items.map((i) => i.id)],
  );
}

/** Una propuesta, revalidada bajo bloqueo. Orden de bloqueo fijo (ítem → incidente → unidad) para no generar ciclos. */
async function applyOne(c: PoolClient, run: Run, item: Item, policy: Versioned<DispatchPolicy>): Promise<Outcome> {
  const it = await c.query<{ status: string }>("select status from plan_items where id = $1 for update", [item.id]);
  if (it.rows[0]?.status !== "proposed") return { kind: "done" }; // otro applyPlan (o un plan nuevo) ya la procesó
  if (!(await isLatestRun(c, run))) {
    await c.query("update plan_items set status = 'obsolete', blocked_reason = 'obsolete_plan' where id = $1", [item.id]);
    return { kind: "obsolete" };
  }

  const inc = (
    await c.query<{
      territory_id: string;
      revision: number;
      status: string;
      dispatch_blocked: boolean;
      active_hazard: boolean;
      problem_type_id: string | null;
      pt_slug: string | null;
      area_id: string | null;
    }>(
      `select i.territory_id, i.revision, i.status, i.dispatch_blocked, i.active_hazard, i.problem_type_id, pt.slug as pt_slug, i.area_id
       from incidents i left join problem_types pt on pt.id = i.problem_type_id where i.id = $1 for update of i`,
      [item.incidentId],
    )
  ).rows[0];
  if (!inc) return block(c, item, "incident_closed");

  // Revisión vista por el plan. Sin dato no se puede verificar: se trata como obsoleto y se replanifica.
  const seen = run.incidentRevisions[item.incidentId];
  if (typeof seen !== "number" || seen !== inc.revision) return { kind: "replan" };

  if (inc.status !== "open") {
    return block(c, item, inc.status === "resolved" || inc.status === "archived" ? "incident_closed" : "active_assignment");
  }
  if (inc.dispatch_blocked) return block(c, item, "dispatch_blocked");
  const active = await c.query("select 1 from assignments where incident_id = $1 and status in ('offered', 'accepted', 'in_progress')", [item.incidentId]);
  if (active.rows[0]) return block(c, item, "active_assignment");

  const unit = (
    await c.query<{ territory_id: string; status: string; unit_kind: string; capacity: number; service_radius_m: number | null; fresh: boolean; distance_m: number | null }>(
      `select u.territory_id, u.status, u.unit_kind, u.capacity, u.service_radius_m,
         (u.location is not null and u.location_updated_at is not null
           and u.location_updated_at >= now() - make_interval(mins => $3)) as fresh,
         case when u.location is null then null
              else round(st_distance(u.location, (select location from incidents where id = $2)))::int end as distance_m
       from response_units u where u.id = $1 for update of u`,
      [item.unitId, item.incidentId, policy.config.position_max_age_min],
    )
  ).rows[0];
  if (!unit || unit.territory_id !== inc.territory_id || unit.status !== "enabled") return block(c, item, "unit_unavailable");

  const used = await c.query<{ n: number }>(
    "select count(*)::int as n from assignments where unit_id = $1 and status in ('offered', 'accepted', 'in_progress')",
    [item.unitId],
  );
  if (used.rows[0].n >= unit.capacity) return block(c, item, "no_capacity");

  if (!inc.problem_type_id || !inc.pt_slug) return block(c, item, "unknown_type");
  // Capacidades requeridas efectivas, incluidas las de condición `active_hazard` (diseño §5 paso 7).
  const missing = await c.query<{ slug: string }>(
    `select c.slug from problem_type_requirements r join capabilities c on c.id = r.capability_id
     where r.problem_type_id = $1 and (r.condition = 'always' or (r.condition = 'active_hazard' and $2))
       and not exists (select 1 from unit_capabilities uc where uc.unit_id = $3 and uc.capability_id = r.capability_id)`,
    [inc.problem_type_id, inc.active_hazard, item.unitId],
  );
  if (missing.rows.length) return block(c, item, "no_capable_unit");

  const strategy = policy.config.strategies[inc.pt_slug] ?? policy.config.default_strategy;
  if (strategy === "manual") return block(c, item, "manual_strategy");
  if (strategy === "nearest_mobile") {
    if (unit.unit_kind !== MOBILE_UNIT_KIND) return block(c, item, "not_mobile_unit");
    if (!unit.fresh || unit.distance_m === null) return block(c, item, "stale_position");
    const radius = Math.min(policy.config.max_distance_m, unit.service_radius_m ?? Number.POSITIVE_INFINITY);
    if (unit.distance_m > radius) return block(c, item, "out_of_radius");
  } else {
    const owner = await c.query(
      "select 1 from area_responsibilities where unit_id = $1 and area_id = $2 and problem_type_id = $3",
      [item.unitId, inc.area_id, inc.problem_type_id],
    );
    if (!owner.rows[0]) return block(c, item, "no_zone_owner");
  }

  // El índice único parcial es la última garantía de una orden activa por incidente.
  const ins = await c.query<{ id: string }>(
    `insert into assignments (incident_id, unit_id, plan_item_id, status, distance_m, reasons, assessment_id, policy_version_id)
     values ($1, $2, $3, 'offered', $4, $5,
       (select id from incident_assessments where incident_id = $1 order by created_at desc limit 1), $6)
     on conflict (incident_id) where status in ('offered', 'accepted', 'in_progress') do nothing
     returning id`,
    [item.incidentId, item.unitId, item.id, strategy === "nearest_mobile" ? unit.distance_m : null, JSON.stringify(item.reasons ?? []), policy.id],
  );
  if (!ins.rows[0]) return block(c, item, "active_assignment");
  const assignmentId = ins.rows[0].id;

  await c.query("update incidents set status = 'assigned', updated_at = now() where id = $1", [item.incidentId]);
  await c.query("update plan_items set status = 'executed' where id = $1", [item.id]);
  await appendEvent(c, {
    entityType: "assignment",
    entityId: assignmentId,
    kind: "assignment_offered",
    actorType: "system",
    data: { incident_id: item.incidentId, unit_id: item.unitId, plan_run_id: run.id, plan_item_id: item.id, strategy, distance_m: unit.distance_m },
  });
  await appendEvent(c, { entityType: "incident", entityId: item.incidentId, kind: "assigned", actorType: "system", data: { assignment_id: assignmentId, unit_id: item.unitId } });
  return { kind: "created", assignmentId };
}

async function isLatestRun(db: Pool | PoolClient, run: Run): Promise<boolean> {
  const latest = await db.query<{ id: string }>(
    "select id from plan_runs where territory_id = $1 order by computed_at desc, created_at desc limit 1",
    [run.territoryId],
  );
  return latest.rows[0]?.id === run.id;
}

async function block(c: PoolClient, item: Item, reason: SkipReason): Promise<Outcome> {
  await c.query("update plan_items set status = 'blocked', blocked_reason = $2 where id = $1", [item.id, reason]);
  return { kind: "skipped", reason };
}

/** El plan quedó viejo frente a la base: se pide uno nuevo (idempotente por plan). */
async function requestReplan(pool: Pool, run: Run): Promise<void> {
  await enqueue(pool, {
    kind: "plan",
    entityType: "territory",
    entityId: run.territoryId,
    entityRevision: 0,
    territoryId: run.territoryId,
    payload: { trigger: "dispatch_stale", plan_run_id: run.id },
    dedupeSuffix: `dispatch_stale:${run.id}`,
  });
}
