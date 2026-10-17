import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { importAreas, parseFeatures } from "@/server/geo/import-areas";
import { withTx } from "@/server/db/tx";
import { appendCitizenMessage, createDraft, getReport, setLocation } from "@/server/intake/drafts";
import { confirmReport } from "@/server/intake/confirm";
import { claimNext, completeJob, enqueue, failJob } from "@/server/jobs/queue";
import { handlers } from "@/server/jobs/handlers";
import { runOnce } from "@/server/jobs/worker-loop";
import { newSession, territoryId, testDeps } from "./fakes";
import { resetDb, testDb } from "./setup";

const ENTITY = "00000000-0000-4000-8000-000000000001";

describe("cola de jobs (correcciones de revisión del PR #1)", () => {
  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
  });

  it("un worker que perdió el lease no pisa el estado del job retomado por otro", async () => {
    const pool = await testDb();
    await enqueue(pool, { kind: "plan", entityType: "territory", entityId: ENTITY, entityRevision: 1 });
    const a = (await claimNext(pool, "w1", 60))!;
    await pool.query("update jobs set lease_until = now() - interval '1 second'");
    const b = (await claimNext(pool, "w2", 60))!;
    expect(b.id).toBe(a.id);
    expect(await completeJob(pool, a.id, "w1")).toBe(false);
    expect((await failJob(pool, a, "w1", "tarde")).applied).toBe(false);
    expect((await pool.query("select status, locked_by from jobs")).rows[0]).toEqual({ status: "running", locked_by: "w2" });
    expect(await completeJob(pool, b.id, "w2")).toBe(true);
  });

  it("un job retomado tras vencer el lease sin intentos restantes queda failed y abre revisión", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    await enqueue(pool, { kind: "evaluate_report", entityType: "report", entityId: ENTITY, entityRevision: 1, territoryId: t });
    // Simula 3 workers que murieron a mitad de ejecución.
    await pool.query("update jobs set status = 'running', attempts = 3, lease_until = now() - interval '1 second', locked_by = 'muerto'");
    expect(await runOnce(testDeps(pool), handlers, { workerId: "w1" })).toBe(true);
    expect((await pool.query("select status from jobs")).rows[0].status).toBe("failed");
    const ri = await pool.query("select kind, entity_id from review_items where status = 'open'");
    expect(ri.rows).toEqual([{ kind: "provider_failure", entity_id: ENTITY }]);
  });

  it("reintentar la confirmación revive un process_report fallido", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    const s = await newSession(pool);
    const id = await withTx((c) => createDraft(c, { sessionId: s, territoryId: t }), pool);
    await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: s, clientMessageId: "msg-00000001", body: "pozo" }), pool);
    await withTx((c) => setLocation(c, { reportId: id, sessionId: s, lon: -56.1993, lat: -34.9068, source: "map" }), pool);
    const first = await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
    await pool.query("update jobs set status = 'failed', attempts = 3");
    await pool.query("update reports set processing = 'error' where id = $1", [id]);

    const again = await withTx((c) => confirmReport(c, { reportId: id, sessionId: s, idempotencyKey: "key-00000001" }), pool);
    expect(again.jobId).toBe(first.jobId);
    expect((await pool.query("select status, attempts from jobs")).rows[0]).toEqual({ status: "pending", attempts: 0 });
    expect((await getReport(pool, id)).processing).toBe("pending");
    // Un job pendiente sigue sin duplicarse ni reiniciarse.
    const rev = (await getReport(pool, id)).confirmed_revision!;
    expect(await enqueue(pool, { kind: "process_report", entityType: "report", entityId: id, entityRevision: rev })).toMatchObject({ created: false, revived: false });
  });

  it("reimportar el mismo GeoJSON no cambia nada; uno corregido actualiza la geometría; otra fuente actualiza la procedencia", async () => {
    const pool = await testDb();
    const src = (await pool.query("select source_url, source_date from areas limit 1")).rows[0];
    const base = { territorySlug: "montevideo", file: "barrios-montevideo.geojson", nameProperty: "barrio", idProperty: "ogc_fid" };
    const same = await importAreas(pool, { ...base, sourceUrl: src.source_url, sourceDate: src.source_date.toISOString().slice(0, 10) });
    expect(same).toMatchObject({ inserted: 0, updated: 0, total: 62 });

    const moved = await importAreas(pool, { ...base, sourceUrl: "https://ejemplo.test/barrios.json", sourceDate: "2026-10-18" });
    expect(moved.updated).toBe(62);
    expect((await pool.query("select distinct source_url from areas")).rows).toEqual([{ source_url: "https://ejemplo.test/barrios.json" }]);
    await pool.query("update areas set checksum = 'viejo', name = 'NOMBRE VIEJO' where external_id = '51'");
    const fixed = await importAreas(pool, { ...base, sourceUrl: "https://ejemplo.test/barrios.json", sourceDate: "2026-10-18" });
    expect(fixed.updated).toBe(1);
    expect((await pool.query("select name from areas where external_id = '51'")).rows[0].name).toBe("CENTRO");
  });

  it("un mapeo de propiedades equivocado falla antes de escribir y no colapsa las áreas", async () => {
    const pool = await testDb();
    const before = (await pool.query("select count(*)::int as n, count(distinct st_astext(geom))::int as g from areas")).rows[0];
    await expect(
      importAreas(pool, { territorySlug: "montevideo", file: "barrios-montevideo.geojson", nameProperty: "barrio", idProperty: "id" }),
    ).rejects.toThrow("feature 0: falta la propiedad de id 'id'");
    await expect(
      importAreas(pool, { territorySlug: "montevideo", file: "barrios-montevideo.geojson", nameProperty: "name", idProperty: "ogc_fid" }),
    ).rejects.toThrow("propiedad de nombre 'name'");
    expect((await pool.query("select count(*)::int as n, count(distinct st_astext(geom))::int as g from areas")).rows[0]).toEqual(before);

    const geom = { type: "MultiPolygon", coordinates: [] };
    expect(() => parseFeatures({ features: [{ properties: { k: 1, n: "A" }, geometry: geom }, { properties: { k: 1, n: "B" }, geometry: geom }] }, { idProperty: "k", nameProperty: "n" }))
      .toThrow("comparten el id '1'");
    expect(() => parseFeatures({ features: [{ properties: { k: 1, n: "  " }, geometry: geom }] }, { idProperty: "k", nameProperty: "n" })).toThrow("vacía");
  });
});
