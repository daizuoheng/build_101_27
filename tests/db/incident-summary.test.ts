import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { summarizeIncidents } from "@/server/incidents/queries";
import { territoryId } from "./fakes";
import { resetDb, testDb } from "./setup";

let pool: Pool;
let t: string;

async function incident(status: string, over: { band?: string; resolvedAt?: string } = {}) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into incidents (territory_id, location, status, priority_band, resolved_at)
     values ($1, st_setsrid(st_makepoint(-56.19, -34.90), 4326)::geography, $2, $3, $4::timestamptz) returning id`,
    [t, status, over.band ?? "medium", over.resolvedAt ?? null],
  );
  return rows[0].id;
}

describe("contadores del encabezado de incidentes", () => {
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    t = await territoryId(pool);
  });

  it("cuentan todo el territorio, más allá del límite de la lista, y resueltos por el día local pedido", async () => {
    await pool.query(
      `insert into incidents (territory_id, location, status, priority_band)
       select $1, st_setsrid(st_makepoint(-56.19, -34.90), 4326)::geography, 'open', 'low' from generate_series(1, 510)`,
      [t],
    );
    await incident("assigned", { band: "high" });
    const revisar = await incident("in_progress");
    await pool.query(
      "insert into review_items (territory_id, kind, entity_type, entity_id, status) values ($1, 'provider_failure', 'incident', $2, 'open')",
      [t, revisar],
    );
    await incident("resolved", { resolvedAt: "2026-10-17T15:00:00Z" });
    // Resuelto ayer en Montevideo (UTC-3) y editado hoy: cuenta por cuándo se resolvió, no por su última escritura.
    await incident("resolved", { resolvedAt: "2026-10-17T02:00:00Z" });
    await incident("resolved", { resolvedAt: "2026-10-15T15:00:00Z" });
    await incident("archived", { band: "high" });

    expect(await summarizeIncidents(pool, t, { today: "2026-10-17T03:00:00.000Z", yesterday: "2026-10-16T03:00:00.000Z" })).toEqual({
      active: 512,
      activeHigh: 1,
      review: 1,
      resolvedToday: 1,
      resolvedYesterday: 1,
    });
  });
});
