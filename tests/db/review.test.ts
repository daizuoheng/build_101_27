// Cola de revisión (Tarea 14): resolución de ítems con los servicios de dominio, cola ordenada y rutas.
import type { Pool } from "pg";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedAll } from "../../seeds";
import { seedTerritoryDemoB } from "../../seeds/territory-demo-b";
import type { JevCall } from "@/server/ai/jev/client";
import type { InternalSession } from "@/server/access/internal-session";
import type { Actor } from "@/server/contracts";
import { getActivePolicy } from "@/server/config/policies";
import { withTx } from "@/server/db/tx";
import { transitionAssignment } from "@/server/dispatch/transitions";
import { DomainError } from "@/server/errors";
import { locatePoint } from "@/server/geo/locate";
import { linkReport } from "@/server/incidents/links";
import { getEvaluation } from "@/server/intake/evaluations";
import { indicatesActiveHazard } from "@/server/intake/branches";
import { handlers } from "@/server/jobs/handlers";
import { runOnce } from "@/server/jobs/worker-loop";
import { computePriority } from "@/server/pipeline/priority";
import { actionsFor } from "@/server/review/actions";
import { openReviewItem } from "@/server/review/items";
import { listReviewQueue } from "@/server/review/queue";
import { resolveReviewItem, resolveReviewItemIdempotent } from "@/server/review/resolve";
import type { ResolveAction, ReviewKind } from "@/shared/contracts/review";
import { GET as getQueue } from "@/app/api/operacion/review/route";
import { POST as postResolve } from "@/app/api/operacion/review/[id]/resolve/route";
import { P, confirmedReport, fakeAnswers, fakeComparison, fakeJev, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

// Sesión del servidor simulada: las rutas se prueban de punta a punta salvo la cookie.
const session = vi.hoisted(() => ({ current: null as InternalSession | null }));
vi.mock("@/server/access/internal-session", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/access/internal-session")>();
  return {
    ...orig,
    requireOperatorSession: async () => {
      if (!session.current) throw new DomainError("unauthorized", 401, "Iniciá sesión.");
      return session.current;
    },
  };
});

const OPERATOR: Actor = { type: "operator", id: "00000000-0000-4000-8000-0000000000aa" };
const OTHER_OPERATOR: Actor = { type: "operator", id: "00000000-0000-4000-8000-0000000000ab" };
const east = (m: number) => ({ lon: P.lon + m * 0.00001095, lat: P.lat });
const isCompare = (call: JevCall) => Object.keys(call.questions).some((k) => k.startsWith("match_"));

let pool: Pool;
let t: string;

const one = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0] as T;
const count = async (sql: string, args: unknown[] = []) => (await one<{ n: number }>(sql, args)).n;

async function expectDomainError(p: Promise<unknown>, status: number, code?: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).status).toBe(status);
  if (code) expect((err as DomainError).code).toBe(code);
}

async function insertIncident(typeSlug: string, over: { at?: { lon: number; lat: number }; band?: string; hazard?: boolean; territory?: string } = {}) {
  const at = over.at ?? P;
  const { rows } = await pool.query<{ id: string }>(
    `insert into incidents (territory_id, problem_type_id, location, title, priority_band, active_hazard)
     select $1, id, st_setsrid(st_makepoint($2, $3), 4326)::geography, name, $5, $6 from problem_types where slug = $4 returning id`,
    [over.territory ?? t, at.lon, at.lat, typeSlug, over.band ?? "unknown", over.hazard ?? false],
  );
  return rows[0].id;
}

/** Dos incidentes cerca de P y un reporte en P que Jev no sabe a cuál asociar ⇒ `uncertain_duplicate` abierto. */
async function uncertainDuplicate() {
  const a = await insertIncident("bache", { at: east(5) });
  const b = await insertIncident("bache", { at: east(-5) });
  const reportId = await confirmedReport(pool, t);
  const jev = fakeJev((call) => (isCompare(call) ? fakeComparison({ c1: { match: "same_incident" }, c2: { match: "same_incident" } }) : fakeAnswers()));
  await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
  const item = await one<{ id: string }>("select id from review_items where kind = 'uncertain_duplicate' and entity_id = $1 and status = 'open'", [reportId]);
  return { a, b, reportId, itemId: item.id };
}

/** Incidente creado por el pipeline (con su evaluación base, que necesitan las correcciones). */
async function pipelineIncident() {
  const reportId = await confirmedReport(pool, t);
  await runOnce(testDeps(pool, fakeJev()), handlers, { workerId: "test" });
  return (await one<{ incident_id: string }>("select incident_id from report_incident_links where report_id = $1 and active", [reportId])).incident_id;
}

async function unitWithOrder(incidentId: string, status = "offered", over: { reviewBlocked?: boolean } = {}) {
  const unit = await one<{ id: string }>(
    "insert into response_units (territory_id, slug, name, unit_kind, capacity) values ($1, $2, 'U', 'mobile_crew', 1) returning id",
    [t, `u-${Math.random().toString(36).slice(2, 8)}`],
  );
  const a = await one<{ id: string; version: number }>(
    "insert into assignments (incident_id, unit_id, status, review_blocked) values ($1, $2, $3, $4) returning id, version",
    [incidentId, unit.id, status, over.reviewBlocked ?? false],
  );
  await pool.query("update incidents set status = 'assigned' where id = $1", [incidentId]);
  return { unitId: unit.id, assignmentId: a.id, version: a.version };
}

/** Orden rechazada por la unidad ⇒ `rejected_assignment` abierto sobre el incidente. */
async function rejectedOrder(incidentId: string) {
  const o = await unitWithOrder(incidentId);
  await withTx((c) => transitionAssignment(c, {
    assignmentId: o.assignmentId, action: "reject", expectedVersion: o.version, reason: "sin acceso",
    actor: { type: "unit", id: "00000000-0000-4000-8000-0000000000bb", unitId: o.unitId },
  }), pool);
  return (await one<{ id: string }>("select id from review_items where kind = 'rejected_assignment' and entity_id = $1 and status = 'open'", [incidentId])).id;
}

const resolve = (reviewItemId: string, resolution: ResolveAction, actor: Actor = OPERATOR, note?: string) =>
  withTx((c) => resolveReviewItem(c, { reviewItemId, actor, resolution, note }), pool);

const itemOf = (id: string) => one<{ status: string; resolution: Record<string, unknown> | null; resolved_by: string | null }>(
  "select status, resolution, resolved_by from review_items where id = $1", [id],
);
const blocked = async (id: string) => (await one<{ dispatch_blocked: boolean }>("select dispatch_blocked from incidents where id = $1", [id])).dispatch_blocked;
const planJobs = (itemId: string) => count("select count(*)::int as n from jobs where kind = 'plan' and dedupe_key like $1", [`%:review:${itemId}`]);

describe("resolución de ítems de revisión", () => {
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    t = await territoryId(pool);
    session.current = null;
  });

  it("uncertain_duplicate + link: vínculo manual, reevaluación del elegido, candidatos desbloqueados y plan", async () => {
    const { a, b, reportId, itemId } = await uncertainDuplicate();
    expect(await blocked(a)).toBe(true);
    expect(await blocked(b)).toBe(true);

    expect(await resolve(itemId, { action: "link", incidentId: a })).toEqual({ reviewItemId: itemId, status: "resolved" });

    expect((await pool.query("select incident_id, origin from report_incident_links where report_id = $1 and active", [reportId])).rows)
      .toEqual([{ incident_id: a, origin: "manual" }]);
    expect(await count("select count(*)::int as n from jobs where kind = 'assess_incident' and entity_id = $1", [a])).toBe(1);
    expect(await blocked(a)).toBe(false);
    expect(await blocked(b)).toBe(false);
    const item = await itemOf(itemId);
    expect(item).toMatchObject({ status: "resolved", resolved_by: OPERATOR.id });
    expect(item.resolution).toMatchObject({ action: "link", incidentId: a });
    expect(await planJobs(itemId)).toBe(1);
    expect(await count("select count(*)::int as n from events where kind = 'review_resolved' and entity_type = 'report' and entity_id = $1", [reportId])).toBe(1);
  });

  it("link a un incidente que no es candidato ⇒ 400 not_a_candidate y el ítem sigue abierto", async () => {
    const { itemId } = await uncertainDuplicate();
    const other = await insertIncident("bache", { at: east(800) });
    await expectDomainError(resolve(itemId, { action: "link", incidentId: other }), 400, "not_a_candidate");
    expect((await itemOf(itemId)).status).toBe("open");
  });

  it("create_incident sobre un uncertain_duplicate crea el incidente que daría processReport", async () => {
    const { a, b, reportId, itemId } = await uncertainDuplicate();
    expect(await resolve(itemId, { action: "create_incident" })).toEqual({ reviewItemId: itemId, status: "resolved" });

    const link = await one<{ incident_id: string; origin: string }>("select incident_id, origin from report_incident_links where report_id = $1 and active", [reportId]);
    expect(link.origin).toBe("manual");
    expect([a, b]).not.toContain(link.incident_id);

    // Lo que habría calculado processReport con la misma evaluación.
    const r = await one<{ confirmed_revision: number }>("select confirmed_revision from reports where id = $1", [reportId]);
    const ev = (await getEvaluation(pool, reportId, r.confirmed_revision))!;
    const located = (await locatePoint(pool, P.lon, P.lat))!;
    const typeName = (await one<{ name: string }>("select name from problem_types where id = $1", [ev.problemTypeId])).name;
    const policy = await getActivePolicy(pool, t, "priority");
    const now = new Date();
    const hazard = indicatesActiveHazard(ev);
    const band = computePriority({ severity: ev.severity, activeHazard: hazard, passage: ev.passage, accessibility: ev.accessibility }, now, now, policy.config).band;

    const inc = await one("select title, priority_band, severity, problem_type_id, active_hazard, revision, status from incidents where id = $1", [link.incident_id]);
    expect(inc).toEqual({
      title: `${typeName} — ${located.areaName}`, priority_band: band, severity: ev.severity, problem_type_id: ev.problemTypeId,
      active_hazard: hazard, revision: 1, status: "open",
    });
    const asmt = await one<{ incident_revision: number; reports_considered: string[]; evidence_summary: Record<string, unknown> }>(
      "select incident_revision, reports_considered, evidence_summary from incident_assessments where incident_id = $1", [link.incident_id],
    );
    expect(asmt.incident_revision).toBe(1);
    expect(asmt.reports_considered).toEqual([reportId]);
    expect(asmt.evidence_summary).toMatchObject({ source: "report_evaluation", evaluation_id: ev.id, assessed: { severity: ev.severity, problemTypeId: ev.problemTypeId } });
    expect((await pool.query("select entity_revision from jobs where kind = 'textgen' and entity_id = $1", [link.incident_id])).rows).toEqual([{ entity_revision: 1 }]);
    expect((await one<{ grouping: string }>("select grouping from reports where id = $1", [reportId])).grouping).toBe("linked");
    expect(await blocked(a)).toBe(false);
    expect(await count("select count(*)::int as n from events where kind = 'incident_created_manually' and entity_id = $1", [link.incident_id])).toBe(1);
    expect(await planJobs(itemId)).toBe(1);
  });

  it("create_incident o link llevan al incidente las dudas de evaluación abiertas sobre el reporte, y lo bloquean", async () => {
    for (const action of ["create_incident", "link"] as const) {
      const { a, reportId, itemId } = await uncertainDuplicate();
      const low = (await openReviewItem(pool, {
        territoryId: t, kind: "low_confidence", entityType: "report", entityId: reportId,
        reasons: [{ code: "low_confidence" }], evidenceRefs: [{ report_id: reportId }],
      })).id;
      await resolve(itemId, action === "link" ? { action, incidentId: a } : { action });
      const target = (await one<{ incident_id: string }>("select incident_id from report_incident_links where report_id = $1 and active", [reportId])).incident_id;
      expect((await itemOf(low)).status).toBe("dismissed");
      expect((await itemOf(low)).resolution).toMatchObject({ reason: "moved_to_incident", incident_id: target });
      const moved = await pool.query("select kind, reasons from review_items where entity_type = 'incident' and entity_id = $1 and status = 'open'", [target]);
      expect(moved.rows).toEqual([{ kind: "low_confidence", reasons: [{ code: "low_confidence" }] }]);
      expect(await blocked(target)).toBe(true);
      await resetDb(pool);
      await seedAll(pool);
      t = await territoryId(pool);
    }
  });

  it("create_incident desde otra duda del reporte cierra también su uncertain_duplicate y desbloquea los candidatos", async () => {
    const { a, b, reportId, itemId } = await uncertainDuplicate();
    const low = (await openReviewItem(pool, { territoryId: t, kind: "low_confidence", entityType: "report", entityId: reportId })).id;
    await resolve(low, { action: "create_incident" });
    expect((await itemOf(itemId)).status).toBe("dismissed");
    expect((await itemOf(itemId)).resolution).toMatchObject({ reason: "grouping_decided" });
    expect(await blocked(a)).toBe(false);
    expect(await blocked(b)).toBe(false);
    expect(await count("select count(*)::int as n from events where kind = 'review_closed_by_grouping' and entity_id = $1", [reportId])).toBe(1);
  });

  it("link de un reporte que ya quedó asociado ⇒ 409 report_already_linked, sin mover el vínculo", async () => {
    const { a, b, reportId, itemId } = await uncertainDuplicate();
    await withTx((c) => linkReport(c, { reportId, incidentId: b, origin: "manual", actor: OPERATOR }), pool);
    await expectDomainError(resolve(itemId, { action: "link", incidentId: a }), 409, "report_already_linked");
    expect((await pool.query("select incident_id from report_incident_links where report_id = $1 and active", [reportId])).rows).toEqual([{ incident_id: b }]);
    expect((await itemOf(itemId)).status).toBe("open");
  });

  it("create_incident de un reporte sin evaluación ⇒ 400 report_not_promotable", async () => {
    const reportId = await confirmedReport(pool, t);
    const { id } = await openReviewItem(pool, { territoryId: t, kind: "insufficient_evidence", entityType: "report", entityId: reportId });
    await expectDomainError(resolve(id, { action: "create_incident" }), 400, "report_not_promotable");
    expect((await itemOf(id)).status).toBe("open");
  });

  it("rejected_assignment + allow_dispatch: el incidente se desbloquea y se replanifica", async () => {
    const inc = await insertIncident("bache", { band: "medium" });
    const itemId = await rejectedOrder(inc);
    expect(await blocked(inc)).toBe(true);
    expect(await resolve(itemId, { action: "allow_dispatch" })).toEqual({ reviewItemId: itemId, status: "resolved" });
    expect(await blocked(inc)).toBe(false);
    expect(await planJobs(itemId)).toBe(1);
  });

  it("dos ítems abiertos sobre un incidente: resolver uno no lo desbloquea, el otro sí", async () => {
    const inc = await insertIncident("bache");
    const contradiction = (await openReviewItem(pool, { territoryId: t, kind: "contradiction", entityType: "incident", entityId: inc })).id;
    const rejected = await rejectedOrder(inc);
    expect(await resolve(contradiction, { action: "dismiss" })).toEqual({ reviewItemId: contradiction, status: "dismissed" });
    expect(await blocked(inc)).toBe(true);
    await resolve(rejected, { action: "allow_dispatch" });
    expect(await blocked(inc)).toBe(false);
  });

  it("un uncertain_duplicate abierto que lista al incidente como candidato lo mantiene bloqueado", async () => {
    const inc = await insertIncident("bache");
    const own = (await openReviewItem(pool, { territoryId: t, kind: "contradiction", entityType: "incident", entityId: inc })).id;
    const reportId = await confirmedReport(pool, t);
    await openReviewItem(pool, {
      territoryId: t, kind: "uncertain_duplicate", entityType: "report", entityId: reportId,
      evidenceRefs: [{ report_id: reportId, candidate_incident_ids: [inc] }],
    });
    await resolve(own, { action: "allow_dispatch" });
    expect(await blocked(inc)).toBe(true);
  });

  it("set_severity: corrección vigente, revisión + 1 e ítem resuelto, leyendo la revisión bajo lock", async () => {
    const inc = await pipelineIncident();
    // Otro proceso subió la revisión: la acción de la cola no trae una revisión vieja, la lee al aplicar.
    await pool.query("update incidents set revision = revision + 1 where id = $1", [inc]);
    const before = (await one<{ revision: number }>("select revision from incidents where id = $1", [inc])).revision;
    const { id } = await openReviewItem(pool, { territoryId: t, kind: "contradiction", entityType: "incident", entityId: inc });

    await resolve(id, { action: "set_severity", severity: "high" }, OPERATOR, "visto en el lugar");
    const live = await pool.query("select value, reason from incident_overrides where incident_id = $1 and field = 'severity' and removed_at is null", [inc]);
    expect(live.rows).toEqual([{ value: "high", reason: "visto en el lugar" }]);
    expect((await one<{ revision: number; severity: string }>("select revision, severity from incidents where id = $1", [inc]))).toEqual({ revision: before + 1, severity: "high" });
    expect((await itemOf(id)).status).toBe("resolved");
  });

  it("set_severity sobre un incidente cerrado ⇒ 409 incident_closed y el ítem sigue abierto", async () => {
    const inc = await pipelineIncident();
    const { id } = await openReviewItem(pool, { territoryId: t, kind: "contradiction", entityType: "incident", entityId: inc });
    await pool.query("update incidents set status = 'resolved', resolved_at = now() where id = $1", [inc]);
    await expectDomainError(resolve(id, { action: "set_severity", severity: "low" }), 409, "incident_closed");
    expect((await itemOf(id)).status).toBe("open");
  });

  it("incompatible_assignment + allow_dispatch: la orden se desbloquea y su versión sube", async () => {
    const inc = await insertIncident("bache");
    const o = await unitWithOrder(inc, "accepted", { reviewBlocked: true });
    const { id } = await openReviewItem(pool, { territoryId: t, kind: "incompatible_assignment", entityType: "assignment", entityId: o.assignmentId, evidenceRefs: [{ incident_id: inc }] });
    await resolve(id, { action: "allow_dispatch" });
    expect(await one("select review_blocked, version from assignments where id = $1", [o.assignmentId])).toEqual({ review_blocked: false, version: o.version + 1 });
    expect(await count("select count(*)::int as n from events where entity_type = 'assignment' and entity_id = $1 and kind = 'review_unblocked'", [o.assignmentId])).toBe(1);
  });

  it("retry de provider_failure sobre un reporte confirmado en error revive su process_report", async () => {
    const reportId = await confirmedReport(pool, t);
    await pool.query("update jobs set status = 'failed', attempts = max_attempts where kind = 'process_report' and entity_id = $1", [reportId]);
    await pool.query("update reports set processing = 'error' where id = $1", [reportId]);
    const { id } = await openReviewItem(pool, { territoryId: t, kind: "provider_failure", entityType: "report", entityId: reportId });
    await resolve(id, { action: "retry" });
    expect(await one("select status, attempts from jobs where kind = 'process_report' and entity_id = $1", [reportId])).toEqual({ status: "pending", attempts: 0 });
    expect((await one<{ processing: string }>("select processing from reports where id = $1", [reportId])).processing).toBe("pending");
  });

  it("reassign no se ofrece ⇒ 400 action_not_available", async () => {
    const inc = await insertIncident("bache");
    const itemId = await rejectedOrder(inc);
    await expectDomainError(resolve(itemId, { action: "reassign", unitId: "00000000-0000-4000-8000-000000000001" }), 400, "action_not_available");
    expect((await itemOf(itemId)).status).toBe("open");
  });

  it("idempotencia: misma clave dos veces ⇒ un solo efecto; misma clave con otra acción ⇒ 409", async () => {
    const { a, reportId, itemId } = await uncertainDuplicate();
    const body = { resolution: { action: "link" as const, incidentId: a }, idempotencyKey: "review-key-0001" };
    const run = (b: typeof body | { resolution: ResolveAction; idempotencyKey: string }) =>
      withTx((c) => resolveReviewItemIdempotent(c, { reviewItemId: itemId, actor: OPERATOR, body: b }), pool);

    expect(await run(body)).toEqual({ reviewItemId: itemId, status: "resolved", replayed: false });
    expect(await run(body)).toEqual({ reviewItemId: itemId, status: "resolved", replayed: true });
    expect(await count("select count(*)::int as n from report_incident_links where report_id = $1", [reportId])).toBe(1);
    expect(await count("select count(*)::int as n from events where kind = 'review_resolved' and entity_id = $1", [reportId])).toBe(1);
    await expectDomainError(run({ resolution: { action: "dismiss" }, idempotencyKey: body.idempotencyKey }), 409, "idempotency_key_reused");
  });

  it("dos operadores a la vez sobre el mismo ítem: uno gana y el otro recibe 409 review_item_closed", async () => {
    const inc = await insertIncident("bache");
    const itemId = await rejectedOrder(inc);
    const results = await Promise.allSettled([
      withTx((c) => resolveReviewItemIdempotent(c, { reviewItemId: itemId, actor: OPERATOR, body: { resolution: { action: "allow_dispatch" }, idempotencyKey: "review-key-a001" } }), pool),
      withTx((c) => resolveReviewItemIdempotent(c, { reviewItemId: itemId, actor: OTHER_OPERATOR, body: { resolution: { action: "dismiss" }, idempotencyKey: "review-key-b001" } }), pool),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(DomainError);
    expect((failed[0].reason as DomainError).code).toBe("review_item_closed");
    expect(await count("select count(*)::int as n from events where kind = 'review_resolved' and entity_id = $1", [inc])).toBe(1);
  });
});

describe("cola de revisión", () => {
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    t = await territoryId(pool);
    session.current = null;
  });

  it("ordena por peligro activo, banda y antigüedad; no mezcla territorios; acciones de actionsFor", async () => {
    const basura = await insertIncident("basura_acumulada", { band: "low", at: east(300) });
    const fuego = await insertIncident("contenedor_fuego", { band: "high", hazard: true, at: east(600) });
    const reportId = await confirmedReport(pool, t, "Algo raro pasa en la esquina de mi casa, no sé bien qué es pero hace días que está así y nadie hace nada");
    const old = (await openReviewItem(pool, { territoryId: t, kind: "contradiction", entityType: "incident", entityId: basura })).id;
    const rep = (await openReviewItem(pool, { territoryId: t, kind: "insufficient_evidence", entityType: "report", entityId: reportId })).id;
    const fire = (await openReviewItem(pool, { territoryId: t, kind: "rejected_assignment", entityType: "incident", entityId: fuego })).id;
    await pool.query("update review_items set created_at = now() - interval '1 hour' where id = $1", [old]);

    const b = (await seedTerritoryDemoB(pool)).territoryId;
    const foreign = await insertIncident("bache", { territory: b, at: { lon: 0.006, lat: 0.003 } });
    await openReviewItem(pool, { territoryId: b, kind: "contradiction", entityType: "incident", entityId: foreign });

    const items = await listReviewQueue(pool, t);
    expect(items.map((i) => i.id)).toEqual([fire, old, rep]);
    expect(items.map((i) => [i.priorityBand, i.activeHazard])).toEqual([["high", true], ["low", false], ["unknown", false]]);
    for (const i of items) expect(i.actions).toEqual(actionsFor(i.kind, i.entityType));
    const code = (await one<{ public_code: string; description: string }>("select public_code, description from reports where id = $1", [reportId]));
    expect(items[2].title).toBe(`Reporte ${code.public_code}: ${code.description.slice(0, 80)}`);
    expect(items[1].title).toBe("Basura acumulada");

    // Los resueltos salen de la cola por defecto.
    await resolve(old, { action: "dismiss" });
    expect((await listReviewQueue(pool, t)).map((i) => i.id)).toEqual([fire, rep]);
    expect((await listReviewQueue(pool, t, { status: "all" })).map((i) => i.id)).toContain(old);
  });

  it("un reporte con candidatos toma la banda más alta de ellos", async () => {
    const lo = await insertIncident("bache", { band: "low" });
    const hi = await insertIncident("bache", { band: "high" });
    const reportId = await confirmedReport(pool, t);
    await openReviewItem(pool, { territoryId: t, kind: "uncertain_duplicate", entityType: "report", entityId: reportId, evidenceRefs: [{ report_id: reportId, candidate_incident_ids: [lo, hi] }] });
    const [item] = await listReviewQueue(pool, t);
    expect(item).toMatchObject({ entityType: "report", priorityBand: "high", actions: ["link", "create_incident", "dismiss"] });
    // Un candidato ya cerrado no cuenta para la prioridad.
    await pool.query("update incidents set status = 'archived', archived_at = now() where id = $1", [hi]);
    expect((await listReviewQueue(pool, t))[0].priorityBand).toBe("low");
  });
});

describe("rutas de la cola", () => {
  let b: string;
  const asOperator = (territory: string): InternalSession => ({ userId: OPERATOR.id!, role: "operator", territoryId: territory, responseUnitId: null, username: "op" });
  const post = (id: string, body: unknown) =>
    postResolve(new Request(`http://test/api/operacion/review/${id}/resolve`, { method: "POST", body: JSON.stringify(body) }) as NextRequest, { params: Promise.resolve({ id }) });

  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    t = await territoryId(pool);
    b = (await seedTerritoryDemoB(pool)).territoryId;
    session.current = null;
  });

  it("GET: sin sesión 401, otro territorio 403, el propio 200 con ReviewQueueResponse", async () => {
    const inc = await insertIncident("bache");
    await openReviewItem(pool, { territoryId: t, kind: "contradiction", entityType: "incident", entityId: inc });
    const req = () => getQueue(new Request("http://test/api/operacion/review?territory=montevideo"));
    expect((await req()).status).toBe(401);
    session.current = asOperator(b);
    expect((await req()).status).toBe(403);
    session.current = asOperator(t);
    const res = await req();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(typeof body.generatedAt).toBe("string");
  });

  it("POST: un ítem de otro territorio o un id que no es uuid ⇒ 404; el propio ⇒ 200", async () => {
    const inc = await insertIncident("bache");
    const { id } = await openReviewItem(pool, { territoryId: t, kind: "contradiction", entityType: "incident", entityId: inc });
    const body = { resolution: { action: "dismiss" }, idempotencyKey: "route-key-0001", note: "ruido" };
    expect((await post(id, body)).status).toBe(401);
    session.current = asOperator(b);
    expect((await post(id, body)).status).toBe(404);
    expect((await post("no-es-uuid", body)).status).toBe(404);
    expect((await itemOf(id)).status).toBe("open");
    session.current = asOperator(t);
    const res = await post(id, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reviewItemId: id, status: "dismissed", replayed: false });
    expect((await itemOf(id)).resolution).toMatchObject({ action: "dismiss", note: "ruido" });
  });
});

describe("actionsFor", () => {
  const table: [ReviewKind, "report" | "incident" | "assignment", string[]][] = [
    ["uncertain_duplicate", "report", ["link", "create_incident", "dismiss"]],
    ["insufficient_evidence", "report", ["create_incident", "dismiss"]],
    ["insufficient_evidence", "incident", ["allow_dispatch", "set_type", "set_severity", "dismiss"]],
    ["contradiction", "incident", ["set_type", "set_severity", "allow_dispatch", "dismiss"]],
    ["low_confidence", "incident", ["set_type", "set_severity", "allow_dispatch", "dismiss"]],
    ["unknown_type", "incident", ["set_type", "set_severity", "allow_dispatch", "dismiss"]],
    ["contradiction", "report", ["create_incident", "dismiss"]],
    ["low_confidence", "report", ["create_incident", "dismiss"]],
    ["unknown_type", "report", ["create_incident", "dismiss"]],
    ["no_compatible_unit", "incident", ["allow_dispatch", "set_type", "dismiss"]],
    ["rejected_assignment", "incident", ["allow_dispatch", "set_type", "set_severity", "dismiss"]],
    ["incompatible_assignment", "assignment", ["allow_dispatch", "dismiss"]],
    ["provider_failure", "report", ["retry", "dismiss"]],
    ["provider_failure", "incident", ["retry", "dismiss"]],
    ["out_of_coverage", "report", ["dismiss"]],
  ];
  it.each(table)("%s sobre %s", (kind, entity, actions) => {
    expect(actionsFor(kind, entity)).toEqual(actions);
  });
  it("combinaciones fuera de la tabla no ofrecen acciones, y reassign nunca", () => {
    expect(actionsFor("uncertain_duplicate", "incident")).toEqual([]);
    expect(actionsFor("incompatible_assignment", "incident")).toEqual([]);
    expect(actionsFor("out_of_coverage", "incident")).toEqual([]);
  });
});
