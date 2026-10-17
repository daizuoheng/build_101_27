// Lectura del plan para la vista «Plan de atención» y pedido de recálculo manual.
// El plan lo calcula y persiste el job `plan` (Núcleo, src/server/pipeline/plan.ts); acá solo se lee y se encola.

import type { Db } from "../db/pool";
import { withTx } from "../db/tx";
import { appendEvent } from "../events/append";
import { enqueue } from "../jobs/queue";
import type { Pool } from "pg";
import { PRIORITY_BANDS, type PlanItemView, type PlanResponse } from "@/shared/contracts/plan";

const ITEM_STATUSES = ["proposed", "executed", "obsolete", "blocked", "queued"] as const;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Último plan del territorio con el estado actual de cada incidente y su orden activa, o `planRun: null` si no hay. */
export async function getLatestPlan(db: Db, territoryId: string): Promise<PlanResponse> {
  const run = await db.query<{ id: string; computed_at: Date; trigger: string; version: number }>(
    `select pr.id, pr.computed_at, pr.trigger, pv.version
     from plan_runs pr join policy_versions pv on pv.id = pr.policy_version_id
     where pr.territory_id = $1 order by pr.computed_at desc, pr.created_at desc limit 1`,
    [territoryId],
  );
  const r = run.rows[0];
  if (!r) return { planRun: null, items: [] };

  const { rows } = await db.query(
    `select pi.position, pi.status, pi.score_breakdown, pi.reasons, pi.blocked_reason,
       i.id as incident_id, coalesce(i.title, pt.name, 'Incidente') as title, pt.name as pt_name, a.name as area_name,
       i.priority_band, i.active_hazard, i.status as incident_status,
       pu.id as proposed_id, pu.name as proposed_name,
       au.id as assigned_id, au.name as assigned_name, asg.status as assigned_status
     from plan_items pi
     join incidents i on i.id = pi.incident_id
     left join problem_types pt on pt.id = i.problem_type_id
     left join areas a on a.id = i.area_id
     left join response_units pu on pu.id = pi.proposed_unit_id
     left join assignments asg on asg.incident_id = i.id and asg.status in ('offered', 'accepted', 'in_progress')
     left join response_units au on au.id = asg.unit_id
     where pi.plan_run_id = $1
     order by pi.position`,
    [r.id],
  );

  const items: PlanItemView[] = rows.map((x) => {
    const s = (x.score_breakdown ?? {}) as Record<string, unknown>;
    return {
      position: x.position,
      incident: {
        id: x.incident_id,
        title: x.title,
        problemType: x.pt_name ?? null,
        areaName: x.area_name ?? null,
        priorityBand: (PRIORITY_BANDS as readonly string[]).includes(x.priority_band) ? x.priority_band : "unknown",
        activeHazard: x.active_hazard,
        status: x.incident_status,
      },
      score: { waitHours: num(s.waitHours), sources: num(s.sources), bonusHours: num(s.bonusHours), score: num(s.score) },
      proposedUnit: x.proposed_id ? { id: x.proposed_id, name: x.proposed_name } : null,
      assignedUnit: x.assigned_id ? { id: x.assigned_id, name: x.assigned_name, status: x.assigned_status } : null,
      status: (ITEM_STATUSES as readonly string[]).includes(x.status) ? x.status : "queued",
      reasons: strings(x.reasons),
      blockedReason: x.blocked_reason ?? null,
      // Explicación redactada (Tarea 15): todavía no hay textos generados para el plan; la UI usa los motivos.
      explanation: null,
    };
  });

  return {
    planRun: { id: r.id, computedAt: r.computed_at.toISOString(), policyVersion: r.version, trigger: r.trigger },
    items,
  };
}

/**
 * Pide recalcular el plan del territorio (botón «Actualizar plan»). Reutiliza un job `plan` pendiente o en curso
 * para no recalcular por cada clic; si no hay, encola uno nuevo. Registra quién lo pidió.
 */
export async function requestReplan(pool: Pool, input: { territoryId: string; actorId: string }): Promise<{ jobId: string; created: boolean }> {
  return withTx(async (c) => {
    // Serializa pedidos concurrentes del mismo territorio dentro de la transacción.
    await c.query("select pg_advisory_xact_lock(hashtext('plan:' || $1::text))", [input.territoryId]);
    const open = await c.query<{ id: string }>(
      `select id from jobs where kind = 'plan' and entity_type = 'territory' and entity_id = $1 and status in ('pending', 'running')
       order by created_at limit 1`,
      [input.territoryId],
    );
    if (open.rows[0]) return { jobId: open.rows[0].id, created: false };

    const job = await enqueue(c, {
      kind: "plan",
      entityType: "territory",
      entityId: input.territoryId,
      entityRevision: 0,
      territoryId: input.territoryId,
      payload: { trigger: "manual" },
      dedupeSuffix: `manual:${Date.now()}`,
    });
    await appendEvent(c, {
      entityType: "territory",
      entityId: input.territoryId,
      kind: "plan_requested",
      actorType: "operator",
      actorId: input.actorId,
      data: { job_id: job.id, trigger: "manual" },
    });
    return { jobId: job.id, created: true };
  }, pool);
}
