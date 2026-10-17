import type { Db } from "../db/pool";
import type { IntakePolicy } from "../config/policies";
import { territoryBounds } from "./locate";

export type GeocodeHit = { lon: number; lat: number; label: string };
type Fetch = typeof fetch;
type Policy = IntakePolicy["geocoder"];
type Bounds = Awaited<ReturnType<typeof territoryBounds>> | null;

let lastCall = 0;

const normalize = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Formas de escribir una esquina en el Río de la Plata: «A y B», «A esq. B», «A esquina B», «A casi B».
 * Devuelve todas las particiones posibles, porque hay calles con « y » en el nombre (p. ej. «Batlle y Ordóñez»).
 */
export function intersectionCandidates(query: string): [string, string][] {
  const q = query.trim().replace(/\s+/g, " ");
  const sep = /\s+(?:y|e|esq\.?|esquina(?:\s+con)?|casi(?:\s+esquina)?)\s+/gi;
  const out: [string, string][] = [];
  for (const m of q.matchAll(sep)) {
    const a = q.slice(0, m.index).trim();
    const b = q.slice(m.index! + m[0].length).trim();
    if (a.length >= 2 && b.length >= 2) out.push([a, b]);
  }
  return out;
}

async function nominatim(fetchImpl: Fetch, policy: Policy, bounds: Bounds, params: Record<string, string>) {
  const p = new URLSearchParams({ format: "jsonv2", countrycodes: policy.country_codes, ...params });
  if (bounds) {
    p.set("viewbox", `${bounds.minlon},${bounds.maxlat},${bounds.maxlon},${bounds.minlat}`);
    p.set("bounded", "1");
  }
  const wait = lastCall + policy.min_interval_ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetchImpl(`${policy.base_url}/search?${p}`, {
    headers: { "User-Agent": process.env.NOMINATIM_USER_AGENT ?? "RadarUrbano", "Accept-Language": "es" },
    signal: AbortSignal.timeout(policy.timeout_ms),
  });
  if (!res.ok) throw new Error(`geocodificador ${res.status}`);
  return (await res.json()) as { lat: string; lon: string; display_name: string; category?: string; geojson?: { type: string } }[];
}

type Line = { type: string; coordinates: number[][] | number[][][] };

/** Tramos de calle (líneas) con ese nombre dentro de la caja. */
async function streetGeometries(fetchImpl: Fetch, policy: Policy, bounds: Bounds, street: string): Promise<Line[]> {
  const rows = await nominatim(fetchImpl, policy, bounds, {
    q: `${street}, ${policy.query_suffix}`,
    limit: "40",
    dedupe: "0",
    layer: "address",
    polygon_geojson: "1",
  });
  return rows
    .filter((r) => r.category === "highway" && r.geojson && /LineString$/.test(r.geojson.type))
    .map((r) => r.geojson as Line);
}

/** Caja de un conjunto de líneas, agrandada `pad` grados (~110 m por 0,001). */
function boxOf(lines: Line[], pad: number): Bounds {
  const pts = lines.flatMap((l) => (l.type === "LineString" ? (l.coordinates as number[][]) : (l.coordinates as number[][][]).flat()));
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minlon: Math.min(...xs) - pad, maxlon: Math.max(...xs) + pad, minlat: Math.min(...ys) - pad, maxlat: Math.max(...ys) + pad };
}

/**
 * Esquina = punto donde se cruzan los tramos de las dos calles (en OSM las calles que se cruzan comparten nodo).
 * Si no se tocan (cruce a distinto nivel, rotonda), se acepta el punto más cercano entre ambas si están a menos
 * de `toleranceM`. Con varios cruces se toma el primero de PostGIS (determinista).
 */
async function intersect(db: Db, a: Line[], b: Line[], toleranceM: number): Promise<{ lon: number; lat: number } | null> {
  if (!a.length || !b.length) return null;
  const { rows } = await db.query<{ lon: number; lat: number }>(
    `with a as (select st_union(st_setsrid(st_geomfromgeojson(g), 4326)) as g from jsonb_array_elements_text($1::jsonb) g),
          b as (select st_union(st_setsrid(st_geomfromgeojson(g), 4326)) as g from jsonb_array_elements_text($2::jsonb) g),
          p as (
            select case when st_intersects(a.g, b.g)
                        then st_geometryn(st_collectionextract(st_force2d(st_intersection(a.g, b.g)), 1), 1)
                        when st_dwithin(a.g::geography, b.g::geography, $3)
                        then st_closestpoint(a.g, b.g) end as g
            from a, b)
     select st_x(g) as lon, st_y(g) as lat from p where g is not null`,
    [JSON.stringify(a.map((g) => JSON.stringify(g))), JSON.stringify(b.map((g) => JSON.stringify(g))), toleranceM],
  );
  return rows[0] ?? null;
}

/**
 * Cruce de dos calles. Las avenidas largas tienen más tramos que el límite del proveedor, así que si el primer
 * intento no encuentra el cruce, cada calle se vuelve a buscar acotada a la zona de la otra.
 */
async function findIntersection(db: Db, fetchImpl: Fetch, policy: Policy, bounds: Bounds, a: string, b: string) {
  const ga = await streetGeometries(fetchImpl, policy, bounds, a);
  const gb = await streetGeometries(fetchImpl, policy, bounds, b);
  if (!ga.length || !gb.length) return null;
  const first = await intersect(db, ga, gb, 25);
  if (first) return first;
  // Se acota la calle con más tramos a la zona de la que tiene menos.
  const [long, short, longName] = ga.length >= gb.length ? [ga, gb, a] : [gb, ga, b];
  const near = await streetGeometries(fetchImpl, policy, boxOf(short, 0.003), longName);
  return intersect(db, near.length ? near : long, short, 25);
}

/**
 * Geocodificación acotada al territorio, con caché persistida (también de resultados vacíos) y ritmo mínimo
 * entre llamadas según la política. Proveedor: Nominatim (OSM). Si la búsqueda directa no encuentra nada y la
 * consulta parece una esquina, se calcula el cruce de las dos calles con PostGIS.
 */
export async function geocode(
  db: Db,
  { query, territoryId, policy, fetchImpl = fetch }: { query: string; territoryId: string; policy: Policy; fetchImpl?: Fetch },
): Promise<GeocodeHit | null> {
  const full = `${query}, ${policy.query_suffix}`;
  const key = `${territoryId}:${normalize(full)}`;
  const cached = await db.query<{ result: { hit: GeocodeHit | null } }>(
    "select result from geocode_cache where provider = $1 and query_norm = $2",
    [policy.provider, key],
  );
  if (cached.rows[0]) return cached.rows[0].result.hit;

  const bounds = await territoryBounds(db, territoryId);
  const direct = await nominatim(fetchImpl, policy, bounds, { q: full, limit: "1" });
  let hit: GeocodeHit | null = direct[0] ? { lon: Number(direct[0].lon), lat: Number(direct[0].lat), label: direct[0].display_name } : null;

  if (!hit) {
    for (const [a, b] of intersectionCandidates(query)) {
      const point = await findIntersection(db, fetchImpl, policy, bounds, a, b);
      if (point) {
        hit = { ...point, label: `${a} y ${b}` };
        break;
      }
    }
  }

  await db.query(
    "insert into geocode_cache (provider, query_norm, result) values ($1, $2, $3) on conflict do nothing",
    [policy.provider, key, { hit }],
  );
  return hit;
}
