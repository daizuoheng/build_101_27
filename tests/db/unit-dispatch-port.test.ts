// El puerto de despacho de la bandeja de unidad (Recepción) tiene que estar conectado a `transitionAssignment`
// (Operación): si queda en null, la ruta de acciones de /unidad responde 503 y ninguna orden se puede aceptar.
import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { refreshDemoPositions, seedDemo } from "../../seeds/demo";
import { withTx } from "@/server/db/tx";
import { transitionAssignment as fromDispatch } from "@/server/dispatch/transitions";
import { performUnitAction } from "@/server/unit/actions";
import { transitionAssignment } from "@/server/unit/dispatch-port";
import { confirmedReport, drain, fakeJev, territoryId } from "./fakes";
import { resetDb, testDb } from "./setup";

describe("puerto de despacho de la bandeja de unidad", () => {
  let pool: Pool;
  beforeEach(async () => {
    pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
    await seedDemo(pool, "montevideo");
    await refreshDemoPositions(pool, "montevideo");
  });

  it("está conectado a transitionAssignment de Operación", () => {
    expect(transitionAssignment).toBe(fromDispatch);
  });

  it("la unidad acepta su orden con el puerto real", async () => {
    await confirmedReport(pool, await territoryId(pool), "Hay un pozo grande en la esquina");
    await drain(pool, fakeJev());
    const a = (await pool.query<{ id: string; unit_id: string; version: number }>("select id, unit_id, version from assignments where status = 'offered'")).rows[0];
    const user = (await pool.query<{ id: string }>("select id from internal_users where response_unit_id = $1", [a.unit_id])).rows[0];
    const res = await withTx(
      (c) => performUnitAction(c, { transitionAssignment: transitionAssignment! }, {
        assignmentId: a.id, unitId: a.unit_id, userId: user.id,
        body: { action: "accept", expectedVersion: a.version, idempotencyKey: "accept-0001" },
      }),
      pool,
    );
    expect(res).toMatchObject({ status: "accepted", replayed: false });
  });
});
