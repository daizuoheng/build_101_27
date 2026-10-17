import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { seedAll } from "../../seeds";
import { withTx } from "@/server/db/tx";
import type { JevCall } from "@/server/ai/jev/client";
import { appendCitizenMessage, createDraft, getReport, setLocation } from "@/server/intake/drafts";
import { confirmReport } from "@/server/intake/confirm";
import { runOnce } from "@/server/jobs/worker-loop";
import { handlers } from "@/server/jobs/handlers";
import { linkReport, unlinkReport } from "@/server/incidents/links";
import { findCandidates } from "@/server/pipeline/group";
import { incidentsAffectedByReviewItem, openReviewItem, recomputeDispatchBlocked } from "@/server/review/items";
import { fakeAnswers, fakeComparison, fakeJev, newSession, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

// Plaza Independencia; 1 m de longitud ≈ 0,00001095° a esta latitud.
const P = { lon: -56.1993, lat: -34.9068 };
const east = (m: number) => ({ lon: P.lon + m * 0.00001095, lat: P.lat });

const isCompare = (call: JevCall) => Object.keys(call.questions).some((k) => k.startsWith("match_"));
type Candidates = Record<string, { category: string | null }>;

/** Evaluación simulada fija; la comparación la decide `compare` mirando el estado (categorías por índice local). */
function jevWith(compare: (candidates: Candidates, call: JevCall) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const answersByCall = new Map<JevCall, Record<string, unknown>>();
  const jev = fakeJev((call) => answersByCall.get(call) ?? fakeAnswers());
  const systemOne = jev.systemOne.bind(jev);
  jev.systemOne = async (call) => {
    if (isCompare(call)) answersByCall.set(call, await compare((call.state as { candidates: Candidates }).candidates, call));
    return systemOne(call);
  };
  return jev;
}

async function insertIncident(pool: Pool, t: string, at: { lon: number; lat: number }, typeSlug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into incidents (territory_id, problem_type_id, location, title)
     select $1, id, st_setsrid(st_makepoint($2, $3), 4326)::geography, name from problem_types where slug = $4 returning id`,
    [t, at.lon, at.lat, typeSlug],
  );
  return rows[0].id;
}

async function confirmedReport(pool: Pool, t: string, at: { lon: number; lat: number }, text = "Hay un pozo grande en la calle") {
  const s = await newSession(pool);
  const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
  await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: text }), pool);
  await withTx((c) => setLocation(c, { reportId: id, sessionId: s, ...at, source: "map" }), pool);
  await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
  return id;
}

const count = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query<{ n: number }>(sql, params)).rows[0].n;

describe("agrupación automática", () => {
  let pool: Pool;
  let t: string;
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    t = await territoryId(pool);
  });

  it("findCandidates: solo abiertos dentro del radio, por distancia, y avisa si el límite trunca", async () => {
    const near = await insertIncident(pool, t, east(5), "bache");
    const nearer = await insertIncident(pool, t, east(2), "bache");
    await insertIncident(pool, t, east(80), "bache");
    const archived = await insertIncident(pool, t, east(1), "bache");
    await pool.query("update incidents set status = 'archived' where id = $1", [archived]);

    const all = await findCandidates(pool, { territoryId: t, ...P, radiusM: 30, limit: 5 });
    expect(all.candidates.map((c) => c.incidentId)).toEqual([nearer, near]);
    expect(all.truncated).toBe(false);
    const one = await findCandidates(pool, { territoryId: t, ...P, radiusM: 30, limit: 1 });
    expect(one).toMatchObject({ candidates: [{ incidentId: nearer }], truncated: true });
  });

  it("dos incidentes a 10 m: el reporte se asocia al correcto y se encola su reevaluación", async () => {
    const bache = await insertIncident(pool, t, P, "bache");
    const basura = await insertIncident(pool, t, east(10), "basura_acumulada");
    const reportId = await confirmedReport(pool, t, east(8)); // más cerca de la basura: c1 = basura, c2 = bache
    const jev = jevWith((cands) =>
      fakeComparison(Object.fromEntries(Object.entries(cands).map(([ref, c]) => [ref, c.category === "Bache" ? { match: "same_incident", p: 0.95 } : { match: "different_incident", p: 0.92, object: 0.9 }]))),
    );
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });

    const compare = jev.calls.filter(isCompare);
    expect(compare).toHaveLength(1);
    expect(Object.keys((compare[0].state as { candidates: Candidates }).candidates)).toEqual(["c1", "c2"]);

    const link = await pool.query("select incident_id, origin, grouping_decision_id from report_incident_links where report_id = $1 and active", [reportId]);
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0]).toMatchObject({ incident_id: bache, origin: "auto" });
    expect(await getReport(pool, reportId)).toMatchObject({ processing: "done", outcome: "applicable" });
    expect((await pool.query("select grouping from reports where id = $1", [reportId])).rows[0].grouping).toBe("linked");
    expect(await count(pool, "select count(*)::int as n from incidents")).toBe(2);

    const dec = await pool.query("select outcome, chosen_incident_id, origin, ai_run_id, candidates from grouping_decisions where report_id = $1", [reportId]);
    expect(dec.rows[0]).toMatchObject({ outcome: "same", chosen_incident_id: bache, origin: "auto" });
    expect(dec.rows[0].candidates.map((c: { incident_id: string }) => c.incident_id)).toEqual([basura, bache]);
    expect(link.rows[0].grouping_decision_id).toBeTruthy();
    const run = await pool.query("select purpose, status from ai_runs where id = $1", [dec.rows[0].ai_run_id]);
    expect(run.rows[0]).toEqual({ purpose: "compare", status: "ok" });

    const assess = await pool.query("select entity_revision from jobs where kind = 'assess_incident' and entity_id = $1", [bache]);
    expect(assess.rows).toEqual([{ entity_revision: 2 }]);
  });

  it("dos same ⇒ reporte en revisión, sin incidente nuevo y candidatos con despacho bloqueado", async () => {
    const a = await insertIncident(pool, t, P, "bache");
    const b = await insertIncident(pool, t, east(10), "bache");
    const reportId = await confirmedReport(pool, t, east(5));
    const jev = jevWith(() => fakeComparison({ c1: { match: "same_incident" }, c2: { match: "same_incident" } }));
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });

    expect((await pool.query("select grouping, processing, outcome from reports where id = $1", [reportId])).rows[0]).toEqual({
      grouping: "review", processing: "done", outcome: "applicable",
    });
    expect(await count(pool, "select count(*)::int as n from incidents")).toBe(2);
    expect(await count(pool, "select count(*)::int as n from report_incident_links where report_id = $1", [reportId])).toBe(0);
    const ri = await pool.query("select kind, entity_type, entity_id, evidence_refs from review_items where status = 'open'");
    expect(ri.rows).toHaveLength(1);
    expect(ri.rows[0]).toMatchObject({ kind: "uncertain_duplicate", entity_type: "report", entity_id: reportId });
    expect(ri.rows[0].evidence_refs[0].candidate_incident_ids.sort()).toEqual([a, b].sort());
    const blocked = await pool.query("select bool_and(dispatch_blocked) as all_blocked from incidents");
    expect(blocked.rows[0].all_blocked).toBe(true);
    expect((await pool.query("select outcome from grouping_decisions where report_id = $1", [reportId])).rows[0].outcome).toBe("uncertain");
  });

  it("sin candidatos ⇒ no llama a la comparación, crea el incidente y guarda la decisión no_candidates", async () => {
    const reportId = await confirmedReport(pool, t, P);
    const jev = jevWith(() => ({}));
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
    expect(jev.calls.filter(isCompare)).toHaveLength(0);
    const dec = await pool.query("select id, outcome, ai_run_id, origin from grouping_decisions where report_id = $1", [reportId]);
    expect(dec.rows[0]).toMatchObject({ outcome: "no_candidates", ai_run_id: null, origin: "auto" });
    const link = await pool.query("select grouping_decision_id from report_incident_links where report_id = $1 and active", [reportId]);
    expect(link.rows[0].grouping_decision_id).toBe(dec.rows[0].id);
    expect((await pool.query("select grouping from reports where id = $1", [reportId])).rows[0].grouping).toBe("linked");
  });

  it("si los candidatos cambian mientras Jev compara, se compara de nuevo antes de escribir", async () => {
    await insertIncident(pool, t, P, "bache");
    const reportId = await confirmedReport(pool, t, east(4));
    let rounds = 0;
    const jev = jevWith(async (cands) => {
      rounds++;
      if (rounds === 1) await insertIncident(pool, t, east(3), "basura_acumulada"); // aparece otro incidente durante la llamada
      return fakeComparison(Object.fromEntries(Object.entries(cands).map(([ref, c]) => [ref, { match: c.category === "Bache" ? "same_incident" : "different_incident" }])));
    });
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
    const compare = jev.calls.filter(isCompare);
    expect(compare).toHaveLength(2);
    expect(Object.keys((compare[1].state as { candidates: Candidates }).candidates)).toHaveLength(2);
    expect((await pool.query("select grouping from reports where id = $1", [reportId])).rows[0].grouping).toBe("linked");
    expect(await count(pool, "select count(*)::int as n from grouping_decisions where report_id = $1", [reportId])).toBe(1);
  });

  it("si los candidatos cambian también en la última vuelta ⇒ revisión, sin guardar la comparación vieja", async () => {
    const first = await insertIncident(pool, t, P, "bache");
    const reportId = await confirmedReport(pool, t, east(4));
    const added: string[] = [];
    const jev = jevWith(async (cands) => {
      added.push(await insertIncident(pool, t, east(2 + added.length), "basura_acumulada")); // cambia en cada vuelta
      return fakeComparison(Object.fromEntries(Object.keys(cands).map((ref) => [ref, { match: "same_incident" }])));
    });
    await runOnce(testDeps(pool, jev), handlers, { workerId: "test" });
    expect((await pool.query("select grouping from reports where id = $1", [reportId])).rows[0].grouping).toBe("review");
    const dec = await pool.query("select outcome, ai_run_id, candidates from grouping_decisions where report_id = $1", [reportId]);
    expect(dec.rows).toHaveLength(1);
    expect(dec.rows[0]).toMatchObject({ outcome: "uncertain", ai_run_id: null });
    // Los candidatos guardados son los vigentes al escribir (los 3), sin respuestas de Jev de otro conjunto.
    expect(dec.rows[0].candidates.map((c: { incident_id: string }) => c.incident_id).sort()).toEqual([first, ...added].sort());
    expect(dec.rows[0].candidates.every((c: { match: unknown }) => c.match === null)).toBe(true);
    const ri = await pool.query("select evidence_refs from review_items where kind = 'uncertain_duplicate' and status = 'open'");
    expect(ri.rows[0].evidence_refs[0].candidate_incident_ids.sort()).toEqual([first, ...added].sort());
  });

  it("resolver el uncertain_duplicate desbloquea a los candidatos salvo que otro ítem abierto los siga bloqueando", async () => {
    const a = await insertIncident(pool, t, P, "bache");
    const b = await insertIncident(pool, t, east(10), "bache");
    await confirmedReport(pool, t, east(5));
    await runOnce(testDeps(pool, jevWith(() => fakeComparison({ c1: { match: "same_incident" }, c2: { match: "same_incident" } }))), handlers, { workerId: "test" });
    // b además tiene su propio ítem abierto
    await openReviewItem(pool, { territoryId: t, kind: "contradiction", entityType: "incident", entityId: b });

    const item = (await pool.query<{ id: string }>("select id from review_items where kind = 'uncertain_duplicate'")).rows[0].id;
    const affected = await incidentsAffectedByReviewItem(pool, item);
    expect(affected.sort()).toEqual([a, b].sort());
    await pool.query("update review_items set status = 'resolved', resolved_at = now() where id = $1", [item]);
    const after = await recomputeDispatchBlocked(pool, affected);
    expect(Object.fromEntries(after.map((x) => [x.id, x.dispatchBlocked]))).toEqual({ [a]: false, [b]: true });
  });

  it("unlinkReport del único reporte ⇒ incidente archivado y orden activa cancelada en la misma transacción", async () => {
    const reportId = await confirmedReport(pool, t, P);
    await runOnce(testDeps(pool, jevWith(() => ({}))), handlers, { workerId: "test" });
    const incidentId = (await pool.query("select incident_id from report_incident_links where report_id = $1 and active", [reportId])).rows[0].incident_id;
    const unit = await pool.query<{ id: string }>(
      "insert into response_units (territory_id, slug, name, unit_kind, capacity) values ($1, 'test-unit', 'Unidad test', 'cuadrilla', 1) returning id",
      [t],
    );
    await pool.query("insert into assignments (incident_id, unit_id, status) values ($1, $2, 'accepted')", [incidentId, unit.rows[0].id]);
    await pool.query("update incidents set status = 'assigned' where id = $1", [incidentId]);

    const res = await withTx((c) => unlinkReport(c, { reportId, reason: "no corresponde", actor: { type: "operator", id: null } }), pool);
    expect(res).toEqual({ incidentId, archived: true });
    expect((await pool.query("select status, archived_at is not null as has_date from incidents where id = $1", [incidentId])).rows[0]).toEqual({ status: "archived", has_date: true });
    expect((await pool.query("select status, closed_reason from assignments")).rows[0]).toEqual({ status: "cancelled", closed_reason: "incident_archived" });
    expect((await pool.query("select active, deactivation_reason from report_incident_links where report_id = $1", [reportId])).rows[0]).toEqual({ active: false, deactivation_reason: "no corresponde" });
    expect((await pool.query("select grouping from reports where id = $1", [reportId])).rows[0].grouping).toBe("pending");
  });

  it("linkReport manual mueve el reporte: el incidente anterior vacío se archiva y el nuevo se reevalúa", async () => {
    const reportId = await confirmedReport(pool, t, P);
    await runOnce(testDeps(pool, jevWith(() => ({}))), handlers, { workerId: "test" });
    const from = (await pool.query("select incident_id from report_incident_links where report_id = $1 and active", [reportId])).rows[0].incident_id;
    const to = await insertIncident(pool, t, east(20), "bache");

    const res = await withTx((c) => linkReport(c, { reportId, incidentId: to, origin: "manual", actor: { type: "operator", id: null } }), pool);
    expect(res.previousIncidentId).toBe(from);
    expect((await pool.query("select status from incidents where id = $1", [from])).rows[0].status).toBe("archived");
    expect(await count(pool, "select count(*)::int as n from report_incident_links where report_id = $1 and active and incident_id = $2", [reportId, to])).toBe(1);
    expect(await count(pool, "select count(*)::int as n from jobs where kind = 'assess_incident' and entity_id = $1", [to])).toBe(1);
  });
});
