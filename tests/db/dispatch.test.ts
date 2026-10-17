import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { withTx } from "@/server/db/tx";
import { applyPlan } from "@/server/dispatch/apply-plan";
import { performOperatorAction } from "@/server/dispatch/operator-action";
import { transitionAssignment } from "@/server/dispatch/transitions";
import { DomainError } from "@/server/errors";
import type { Actor } from "@/server/contracts";
import { territoryId } from "./fakes";
import { resetDb, testDb } from "./setup";

// Fixtures en la base de test. Montevideo, Centro; ~0.001° de longitud ≈ 91 m.
const CENTRO = { lon: -56.1916, lat: -34.9035 };
const OPERATOR: Actor = { type: "operator", id: "00000000-0000-4000-8000-0000000000aa" };
const unitActor = (unitId: string): Actor => ({ type: "unit", id: "00000000-0000-4000-8000-0000000000bb", unitId });

let pool: Pool;
let t: string;

async function unit(slug: string, caps: string[], over: { capacity?: number; lon?: number; positionAgeMin?: number | null; kind?: string; noLocation?: boolean } = {}) {
  const lon = over.lon ?? CENTRO.lon;
  const age = over.positionAgeMin === undefined ? 1 : over.positionAgeMin;
  const { rows } = await pool.query<{ id: string }>(
    `insert into response_units (territory_id, slug, name, unit_kind, capacity, location, location_updated_at, service_radius_m)
     values ($1, $2, $3, $4, $5, case when $9 then null else st_setsrid(st_makepoint($6, $7), 4326)::geography end,
       case when $8::int is null then null else now() - make_interval(mins => $8::int) end, 3000)
     returning id`,
    [t, slug, `Unidad ${slug}`, over.kind ?? "mobile_crew", over.capacity ?? 1, lon, CENTRO.lat, age, over.noLocation ?? false],
  );
  for (const c of caps) {
    await pool.query("insert into unit_capabilities (unit_id, capability_id) select $1, id from capabilities where slug = $2", [rows[0].id, c]);
  }
  return rows[0].id;
}

async function incident(typeSlug: string, over: { activeHazard?: boolean; lonOffset?: number; areaId?: string } = {}) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into incidents (territory_id, problem_type_id, active_hazard, location, title, priority_band, area_id)
     values ($1, (select id from problem_types where slug = $2), $3, st_setsrid(st_makepoint($4, $5), 4326)::geography, $6, 'high', $7)
     returning id`,
    [t, typeSlug, over.activeHazard ?? false, CENTRO.lon + (over.lonOffset ?? 0), CENTRO.lat, `Incidente ${typeSlug}`, over.areaId ?? null],
  );
  return rows[0].id;
}

/** Plan con propuestas en orden; guarda las revisiones vistas como lo hace el job `plan` de Núcleo. */
async function plan(proposals: { incidentId: string; unitId: string }[], revisions?: Record<string, number>) {
  const revs = revisions ?? Object.fromEntries(proposals.map((p) => [p.incidentId, 1]));
  const run = await pool.query<{ id: string }>(
    `insert into plan_runs (territory_id, policy_version_id, computed_at, trigger, snapshot_refs)
     select $1, id, clock_timestamp(), 'manual', $2 from policy_versions where territory_id = $1 and kind = 'planning' and active
     returning id`,
    [t, JSON.stringify({ incident_revisions: revs })],
  );
  let pos = 1;
  for (const p of proposals) {
    await pool.query(
      `insert into plan_items (plan_run_id, incident_id, position, proposed_unit_id, reasons, status)
       values ($1, $2, $3, $4, '["nearest_mobile"]', 'proposed')`,
      [run.rows[0].id, p.incidentId, pos++, p.unitId],
    );
  }
  return run.rows[0].id;
}

const activeOrders = async (unitId: string) =>
  (await pool.query<{ n: number }>("select count(*)::int as n from assignments where unit_id = $1 and status in ('offered', 'accepted', 'in_progress')", [unitId])).rows[0].n;
const one = async <T,>(sql: string, args: unknown[]) => (await pool.query(sql, args)).rows[0] as T;
const transition = (input: Parameters<typeof transitionAssignment>[1]) => withTx((c) => transitionAssignment(c, input), pool);

async function expectDomainError(p: Promise<unknown>, status: number, code?: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).status).toBe(status);
  if (code) expect((err as DomainError).code).toBe(code);
}

describe("despacho transaccional", () => {
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    t = await territoryId(pool);
  });

  it("dos applyPlan concurrentes sobre una unidad de capacidad 1 y dos incidentes crean exactamente una orden", async () => {
    const u = await unit("u1", ["limpieza"]);
    const a = await incident("basura_acumulada");
    const b = await incident("basura_acumulada", { lonOffset: 0.001 });
    const run = await plan([{ incidentId: a, unitId: u }, { incidentId: b, unitId: u }]);

    const [r1, r2] = await Promise.all([applyPlan(pool, run), applyPlan(pool, run)]);
    expect(await activeOrders(u)).toBe(1);
    expect([...r1.created, ...r2.created]).toHaveLength(1);
    const items = (await pool.query("select status, blocked_reason from plan_items where plan_run_id = $1 order by position", [run])).rows;
    expect(items).toEqual([{ status: "executed", blocked_reason: null }, { status: "blocked", blocked_reason: "no_capacity" }]);
    expect(await one("select status from incidents where id = $1", [a])).toEqual({ status: "assigned" });
  });

  it("un segundo plan que propone la misma unidad ocupada no supera su capacidad", async () => {
    const u = await unit("u1", ["limpieza"]);
    const a = await incident("basura_acumulada");
    const b = await incident("basura_acumulada", { lonOffset: 0.001 });
    await applyPlan(pool, await plan([{ incidentId: a, unitId: u }]));
    const res = await applyPlan(pool, await plan([{ incidentId: b, unitId: u }]));
    expect(res.created).toEqual([]);
    expect(res.skipped).toEqual([{ incidentId: b, reason: "no_capacity" }]);
    expect(await activeOrders(u)).toBe(1);
  });

  it("fuego activo y única unidad sin capacidad `fuego` ⇒ sin orden y plan_items.blocked_reason = no_capable_unit", async () => {
    const u = await unit("limpieza", ["limpieza"]);
    const f = await incident("contenedor_fuego", { activeHazard: true });
    const run = await plan([{ incidentId: f, unitId: u }]);
    const res = await applyPlan(pool, run);
    expect(res.created).toEqual([]);
    expect(await one("select status, blocked_reason from plan_items where plan_run_id = $1", [run])).toEqual({ status: "blocked", blocked_reason: "no_capable_unit" });
    expect(await activeOrders(u)).toBe(0);
  });

  it("revalida vigencia de posición y radio de la unidad móvil", async () => {
    const stale = await unit("vieja", ["limpieza"], { positionAgeMin: 40 });
    const far = await unit("lejos", ["limpieza"], { lon: CENTRO.lon + 0.05 }); // ~4,6 km
    const a = await incident("basura_acumulada");
    const b = await incident("basura_acumulada", { lonOffset: 0.001 });
    const res = await applyPlan(pool, await plan([{ incidentId: a, unitId: stale }, { incidentId: b, unitId: far }]));
    expect(res.skipped).toEqual([{ incidentId: a, reason: "stale_position" }, { incidentId: b, reason: "out_of_radius" }]);
  });

  it("unidad móvil sin ubicación ⇒ stale_position", async () => {
    const u = await unit("sin-gps", ["limpieza"], { noLocation: true });
    const a = await incident("basura_acumulada");
    const res = await applyPlan(pool, await plan([{ incidentId: a, unitId: u }]));
    expect(res.skipped).toEqual([{ incidentId: a, reason: "stale_position" }]);
  });

  it("estrategia de zona: despacha al responsable del área sin GPS y bloquea a quien no es responsable", async () => {
    // alumbrado usa `zone_owner` en la política de despacho del seed.
    const area = (await pool.query<{ id: string }>("select id from areas where territory_id = $1 order by name limit 1", [t])).rows[0].id;
    const owner = await unit("oficina", ["alumbrado"], { kind: "zone_office", capacity: 5, noLocation: true, positionAgeMin: null });
    const other = await unit("otra-oficina", ["alumbrado"], { kind: "zone_office", capacity: 5, noLocation: true, positionAgeMin: null });
    await pool.query(
      "insert into area_responsibilities (area_id, problem_type_id, unit_id, precedence) select $1, id, $2, 1 from problem_types where slug = 'alumbrado'",
      [area, owner],
    );
    const a = await incident("alumbrado", { areaId: area });
    const b = await incident("alumbrado", { areaId: area, lonOffset: 0.001 });
    const res = await applyPlan(pool, await plan([{ incidentId: a, unitId: owner }, { incidentId: b, unitId: other }]));
    expect(res.created).toHaveLength(1);
    expect(res.skipped).toEqual([{ incidentId: b, reason: "no_zone_owner" }]);
    expect(await one("select unit_id, distance_m from assignments where incident_id = $1", [a])).toEqual({ unit_id: owner, distance_m: null });
  });

  it("estrategia manual de la política ⇒ manual_strategy, sin orden", async () => {
    await pool.query(
      `update policy_versions set config = jsonb_set(config, '{strategies,basura_acumulada}', '"manual"')
       where territory_id = $1 and kind = 'dispatch' and active`,
      [t],
    );
    const u = await unit("u1", ["limpieza"]);
    const a = await incident("basura_acumulada");
    const res = await applyPlan(pool, await plan([{ incidentId: a, unitId: u }]));
    expect(res.skipped).toEqual([{ incidentId: a, reason: "manual_strategy" }]);
  });

  it("si la revisión del incidente cambió desde el plan, se detiene y encola `plan`", async () => {
    const u = await unit("u1", ["limpieza"], { capacity: 2 });
    const a = await incident("basura_acumulada");
    const b = await incident("basura_acumulada", { lonOffset: 0.001 });
    const run = await plan([{ incidentId: a, unitId: u }, { incidentId: b, unitId: u }]);
    await pool.query("update incidents set revision = 2 where id = $1", [a]);

    const res = await applyPlan(pool, run);
    expect(res).toEqual({ created: [], skipped: [{ incidentId: a, reason: "revision_changed" }], stoppedForReplan: true });
    expect(await activeOrders(u)).toBe(0);
    expect(await one("select count(*)::int as n from jobs where kind = 'plan' and entity_id = $1 and status = 'pending'", [t])).toEqual({ n: 1 });
  });

  it("sin la revisión registrada en el plan, lo trata como obsoleto y replanifica", async () => {
    const u = await unit("u1", ["limpieza"]);
    const a = await incident("basura_acumulada");
    const res = await applyPlan(pool, await plan([{ incidentId: a, unitId: u }], {}));
    expect(res).toEqual({ created: [], skipped: [{ incidentId: a, reason: "revision_changed" }], stoppedForReplan: true });
  });

  it("reaplicar el mismo plan no duplica órdenes; un plan que ya no es el último no se aplica", async () => {
    const u = await unit("u1", ["limpieza"], { capacity: 3 });
    const a = await incident("basura_acumulada");
    const run = await plan([{ incidentId: a, unitId: u }]);
    expect((await applyPlan(pool, run)).created).toHaveLength(1);
    expect((await applyPlan(pool, run)).created).toEqual([]);
    expect(await activeOrders(u)).toBe(1);

    const b = await incident("basura_acumulada", { lonOffset: 0.001 });
    const old = await plan([{ incidentId: b, unitId: u }]);
    await plan([]); // corrida más nueva del territorio
    const res = await applyPlan(pool, old);
    expect(res.created).toEqual([]);
    expect(res.skipped).toEqual([{ incidentId: b, reason: "obsolete_plan" }]);
  });

  describe("transiciones", () => {
    async function offered() {
      const u = await unit("u1", ["limpieza"]);
      const other = await unit("u2", ["limpieza"]);
      const i = await incident("basura_acumulada");
      const { created } = await applyPlan(pool, await plan([{ incidentId: i, unitId: u }]));
      return { u, other, i, a: created[0] };
    }

    it("accept desde otra unidad ⇒ 403", async () => {
      const { other, a } = await offered();
      await expectDomainError(transition({ assignmentId: a, action: "accept", actor: unitActor(other), expectedVersion: 1 }), 403);
    });

    it("versión vieja ⇒ 409; acción no permitida en el estado ⇒ 409; el operador no puede aceptar ⇒ 403", async () => {
      const { u, a } = await offered();
      await expectDomainError(transition({ assignmentId: a, action: "accept", actor: unitActor(u), expectedVersion: 7 }), 409, "version_conflict");
      await expectDomainError(transition({ assignmentId: a, action: "complete", actor: unitActor(u), expectedVersion: 1 }), 409, "invalid_transition");
      await expectDomainError(transition({ assignmentId: a, action: "accept", actor: OPERATOR, expectedVersion: 1 }), 403);
    });

    it("accept → start → complete ⇒ incidente resuelto y la unidad recupera capacidad", async () => {
      const { u, i, a } = await offered();
      expect(await activeOrders(u)).toBe(1);
      const r1 = await transition({ assignmentId: a, action: "accept", actor: unitActor(u), expectedVersion: 1 });
      expect(r1).toEqual({ assignmentId: a, status: "accepted", version: 2 });
      await transition({ assignmentId: a, action: "start", actor: unitActor(u), expectedVersion: 2 });
      expect(await one("select status from incidents where id = $1", [i])).toEqual({ status: "in_progress" });
      await transition({ assignmentId: a, action: "complete", actor: unitActor(u), expectedVersion: 3 });

      expect(await one("select status, resolved_at is not null as resolved from incidents where id = $1", [i])).toEqual({ status: "resolved", resolved: true });
      expect(await activeOrders(u)).toBe(0);
      expect(await one("select accepted_at is not null as acc, started_at is not null as st, completed_at is not null as co from assignments where id = $1", [a])).toEqual({
        acc: true,
        st: true,
        co: true,
      });
      const kinds = (await pool.query("select kind from events where entity_type = 'assignment' and entity_id = $1 order by created_at", [a])).rows.map((r) => r.kind);
      expect(kinds).toEqual(["assignment_offered", "assignment_accepted", "assignment_in_progress", "assignment_completed"]);
      // Toda transición encola `plan` (una por versión, sin duplicar).
      expect(await one("select count(*)::int as n from jobs where kind = 'plan' and entity_id = $1", [t])).toEqual({ n: 3 });
    });

    it("reject ⇒ incidente abierto con despacho bloqueado, revisión abierta y un nuevo plan no lo despacha", async () => {
      const { u, i, a } = await offered();
      await transition({ assignmentId: a, action: "reject", actor: unitActor(u), expectedVersion: 1, reason: "Sin material" });

      expect(await one("select status, dispatch_blocked from incidents where id = $1", [i])).toEqual({ status: "open", dispatch_blocked: true });
      expect(await one("select kind, status from review_items where entity_type = 'incident' and entity_id = $1", [i])).toEqual({
        kind: "rejected_assignment",
        status: "open",
      });
      expect(await one("select status, closed_reason from assignments where id = $1", [a])).toEqual({ status: "rejected", closed_reason: "Sin material" });
      expect(await activeOrders(u)).toBe(0);

      const res = await applyPlan(pool, await plan([{ incidentId: i, unitId: u }]));
      expect(res.created).toEqual([]);
      expect(res.skipped).toEqual([{ incidentId: i, reason: "dispatch_blocked" }]);
    });

    it("cancel del operador también devuelve el incidente a revisión", async () => {
      const { i, a } = await offered();
      await transition({ assignmentId: a, action: "cancel", actor: OPERATOR, expectedVersion: 1, reason: "Reasignar" });
      expect(await one("select status, dispatch_blocked from incidents where id = $1", [i])).toEqual({ status: "open", dispatch_blocked: true });
    });

    it("acción del operador idempotente: el reintento con la misma clave no vuelve a transicionar", async () => {
      const { i, a } = await offered();
      const body = { action: "cancel" as const, expectedVersion: 1, idempotencyKey: "op-key-0001", reason: "Reasignar" };
      const first = await withTx((c) => performOperatorAction(c, { assignmentId: a, userId: OPERATOR.id!, body }), pool);
      const again = await withTx((c) => performOperatorAction(c, { assignmentId: a, userId: OPERATOR.id!, body }), pool);
      expect(first).toEqual({ assignmentId: a, status: "cancelled", version: 2, replayed: false });
      expect(again).toEqual({ assignmentId: a, status: "cancelled", version: 2, replayed: true });
      expect(await one("select count(*)::int as n from events where entity_id = $1 and kind = 'assignment_cancelled'", [a])).toEqual({ n: 1 });
      expect(await one("select status from incidents where id = $1", [i])).toEqual({ status: "open" });
      await expectDomainError(
        withTx((c) => performOperatorAction(c, { assignmentId: a, userId: OPERATOR.id!, body: { ...body, action: "complete" } }), pool),
        409,
        "idempotency_key_reused",
      );
    });

    it("complete del operador cierra la orden y resuelve el incidente", async () => {
      const { u, i, a } = await offered();
      await transition({ assignmentId: a, action: "accept", actor: unitActor(u), expectedVersion: 1 });
      await transition({ assignmentId: a, action: "start", actor: unitActor(u), expectedVersion: 2 });
      await transition({ assignmentId: a, action: "complete", actor: OPERATOR, expectedVersion: 3 });
      expect(await one("select status from incidents where id = $1", [i])).toEqual({ status: "resolved" });
      expect(await one("select actor_type from events where entity_id = $1 and kind = 'assignment_completed'", [a])).toEqual({ actor_type: "operator" });
    });

    it("applyPlan y un rechazo concurrentes sobre el mismo incidente no se bloquean entre sí y respetan una orden activa", async () => {
      const { u, i, a } = await offered();
      // Plan nuevo que vuelve a proponer el mismo incidente mientras la unidad rechaza la orden vigente.
      const run = await plan([{ incidentId: i, unitId: u }]);
      const [, res] = await Promise.all([
        transition({ assignmentId: a, action: "reject", actor: unitActor(u), expectedVersion: 1 }),
        applyPlan(pool, run),
      ]);
      // Gane quien gane el bloqueo: sin deadlock, nunca dos órdenes activas, y el rechazo deja el despacho bloqueado.
      expect(await activeOrders(u)).toBe(0);
      expect(res.created).toEqual([]);
      expect(["active_assignment", "dispatch_blocked"]).toContain(res.skipped[0]?.reason);
      expect(await one("select dispatch_blocked from incidents where id = $1", [i])).toEqual({ dispatch_blocked: true });
    });

    it("review_blocked impide iniciar y completar, pero la unidad todavía puede rechazar", async () => {
      const { u, a } = await offered();
      await transition({ assignmentId: a, action: "accept", actor: unitActor(u), expectedVersion: 1 });
      await pool.query("update assignments set review_blocked = true where id = $1", [a]);
      await expectDomainError(transition({ assignmentId: a, action: "start", actor: unitActor(u), expectedVersion: 2 }), 409, "review_blocked");
      const r = await transition({ assignmentId: a, action: "reject", actor: unitActor(u), expectedVersion: 2 });
      expect(r.status).toBe("rejected");
    });
  });
});
