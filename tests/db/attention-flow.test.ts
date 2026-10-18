// Recorrido completo de Núcleo + Operación con el worker real: reporte → incidente → plan → orden.
// Jev simulado (dobles marcados en fakes.ts); unidades y posiciones de demo (simuladas, `seeds/demo.ts`).
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { seedAll } from "../../seeds";
import { refreshDemoPositions, seedDemo } from "../../seeds/demo";
import type { JevCall } from "@/server/ai/jev/client";
import { confirmedReport, drain, fakeAnswers, fakeComparison, fakeJev, territoryId } from "./fakes";
import { resetDb, testDb } from "./setup";

const ch = (choice: string, p = 0.95) => ({ type: "choice" as const, choice, confidence: 0.9, probabilities: { [choice]: p } });
const one = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const isCompare = (call: JevCall) => Object.keys(call.questions).some((k) => k.startsWith("match_"));
const isAssess = (call: JevCall) => "evolution" in call.questions;

/** Evaluación fija (bache, severidad media); la comparación dice `same_incident` a cada candidato; la reevaluación, sin cambios. */
function jevSame() {
  return fakeJev((call) => {
    if (isCompare(call)) {
      const refs = Object.keys((call.state as { candidates: Record<string, unknown> }).candidates);
      return fakeComparison(Object.fromEntries(refs.map((ref) => [ref, { match: "same_incident" }])));
    }
    if (isAssess(call)) {
      return {
        problem_type: ch("bache"), severity: ch("medium"), active_fire: ch("no"), passage: ch("partial"),
        accessibility: ch("not_affected"), evolution: ch("same"), reports_consistency: ch("consistent"),
      };
    }
    return fakeAnswers();
  });
}

describe("recorrido de atención: reporte → incidente → plan → orden", () => {
  let pool: Pool;
  let t: string;
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    await seedDemo(pool, "montevideo");
    await refreshDemoPositions(pool, "montevideo");
    t = await territoryId(pool);
  });

  it("un reporte de bache termina en una orden 'offered' para una cuadrilla con vialidad, sin esperar al periódico", async () => {
    const jev = fakeJev(); // fakeAnswers(): bache, severidad media, sin fuego ⇒ requiere vialidad
    await confirmedReport(pool, t, "Hay un pozo grande en la esquina");
    await drain(pool, jev);
    const a = await one(pool, `select a.status, i.status as incident_status, array(select c.slug from unit_capabilities uc join capabilities c on c.id = uc.capability_id where uc.unit_id = a.unit_id) as caps
                               from assignments a join incidents i on i.id = a.incident_id`);
    expect(a.status).toBe("offered");
    expect(a.incident_status).toBe("assigned");
    expect(a.caps).toContain("vialidad");
    expect((await one(pool, "select count(*)::int as n from jobs where status = 'failed'")).n).toBe(0);
    expect((await one(pool, "select trigger from plan_runs order by computed_at limit 1")).trigger).toMatch(/^report/);
    // Ningún job `plan` quedó sin correr: el pedido del reporte no depende del periódico.
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'plan' and status <> 'done'")).n).toBe(0);
  });

  it("un segundo reporte vinculado al mismo incidente no crea otra orden", async () => {
    const jev = jevSame();
    await confirmedReport(pool, t);
    await drain(pool, jev);
    expect((await one(pool, "select count(*)::int as n from assignments where status = 'offered'")).n).toBe(1);
    const runsBefore = (await one(pool, "select count(*)::int as n from plan_runs")).n;
    const dispatchBefore = (await one(pool, "select count(*)::int as n from jobs where kind = 'dispatch'")).n;
    const r2 = await confirmedReport(pool, t, "Sigue el pozo");
    await drain(pool, jev);

    expect((await one(pool, "select grouping from reports where id = $1", [r2])).grouping).toBe("linked");
    expect((await one(pool, "select count(*)::int as n from incidents")).n).toBe(1);
    expect((await one(pool, "select count(*)::int as n from assignments")).n).toBe(1);
    expect((await pool.query("select 1 from jobs where kind = 'plan' and dedupe_key like $1", [`%:report:${r2}`])).rows).toHaveLength(1);
    // Foco de revisión 1: el `plan` del reporte y el de la reevaluación corren (o se juntan), pero con la orden ya activa
    // ninguna corrida propone de nuevo ni encola otro despacho.
    const after = await pool.query("select (stats->>'proposals')::int as proposals from plan_runs order by computed_at offset $1", [runsBefore]);
    expect(after.rows.length).toBeGreaterThanOrEqual(1);
    expect(after.rows.every((r) => r.proposals === 0)).toBe(true);
    expect((await one(pool, "select count(*)::int as n from jobs where kind = 'dispatch'")).n).toBe(dispatchBefore);
    expect((await one(pool, "select count(*)::int as n from jobs where status = 'failed'")).n).toBe(0);
  });
});
