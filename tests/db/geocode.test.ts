// Geocodificación de esquinas: Nominatim es un doble SIMULADO (fetch inyectado); el cruce lo calcula PostGIS real.
import { beforeEach, describe, expect, it } from "vitest";
import { seedAll } from "../../seeds";
import { IntakePolicy } from "@/server/config/policies";
import { geocode } from "@/server/geo/geocoder";
import { policies } from "../../seeds/policies";
import { territoryId } from "./fakes";
import { resetDb, testDb } from "./setup";

const policy = { ...IntakePolicy.parse(policies.intake).geocoder, min_interval_ms: 0 };
const line = (coordinates: number[][]) => ({ category: "highway", lat: "0", lon: "0", display_name: "", geojson: { type: "LineString", coordinates } });

/** Nominatim falso: la búsqueda directa no encuentra nada; cada calle devuelve sus tramos. */
function fakeNominatim(streets: Record<string, unknown[]>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const q = new URL(url).searchParams.get("q") ?? "";
    calls.push(q);
    const street = Object.keys(streets).find((s) => q.toLowerCase().startsWith(`${s.toLowerCase()},`));
    return new Response(JSON.stringify(street ? streets[street] : []), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("geocode de esquinas", () => {
  beforeEach(async () => {
    const pool = await testDb();
    await resetDb(pool);
    await seedAll(pool);
  });

  it("calcula el cruce de las dos calles y lo cachea", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    // 18 de Julio (este-oeste) y Ejido (norte-sur) se cruzan en (-56.1868, -34.9056).
    const nom = fakeNominatim({
      "18 de julio": [line([[-56.19, -34.9056], [-56.1868, -34.9056]]), line([[-56.1868, -34.9056], [-56.183, -34.9056]])],
      ejido: [line([[-56.1868, -34.903], [-56.1868, -34.909]])],
    });
    const hit = await geocode(pool, { query: "18 de julio y ejido", territoryId: t, policy, fetchImpl: nom.fetchImpl });
    expect(hit).toMatchObject({ label: "18 de julio y ejido" });
    expect(hit!.lon).toBeCloseTo(-56.1868, 4);
    expect(hit!.lat).toBeCloseTo(-34.9056, 4);

    const n = nom.calls.length;
    expect(await geocode(pool, { query: "18 de julio y ejido", territoryId: t, policy, fetchImpl: nom.fetchImpl })).toEqual(hit);
    expect(nom.calls.length).toBe(n); // segunda vez sale de la caché
  });

  it("calles que no se cruzan (ni están a menos de 25 m) ⇒ null, también cacheado", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    const nom = fakeNominatim({
      rivera: [line([[-56.16, -34.89], [-56.15, -34.89]])],
      comercio: [line([[-56.14, -34.87], [-56.14, -34.88]])],
    });
    expect(await geocode(pool, { query: "Rivera y Comercio", territoryId: t, policy, fetchImpl: nom.fetchImpl })).toBeNull();
    const cached = await pool.query("select result from geocode_cache");
    expect(cached.rows).toEqual([{ result: { hit: null } }]);
  });

  it("prueba como mucho 2 formas de partir una esquina", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    const nom = fakeNominatim({});
    expect(await geocode(pool, { query: "Alfa y Beta y Gamma y Delta", territoryId: t, policy, fetchImpl: nom.fetchImpl })).toBeNull();
    // 1 búsqueda directa + 2 candidatos × 2 calles (sin tramos no hay tercera búsqueda).
    expect(nom.calls.length).toBe(5);
  });

  it("pedidos concurrentes respetan el intervalo mínimo entre llamadas", async () => {
    const pool = await testDb();
    const t = await territoryId(pool);
    const at: number[] = [];
    const fetchImpl = (async () => {
      at.push(Date.now());
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const slow = { ...policy, min_interval_ms: 150 };
    await Promise.all(["Calle Uno 100", "Calle Dos 200", "Calle Tres 300"].map((q) => geocode(pool, { query: q, territoryId: t, policy: slow, fetchImpl })));
    const gaps = at.slice(1).map((x, i) => x - at[i]);
    expect(gaps.every((g) => g >= 140)).toBe(true);
  });
});
