import type { Db } from "../db/pool";
import type { IntakePolicy } from "../config/policies";
import { territoryBounds } from "./locate";

export type GeocodeHit = { lon: number; lat: number; label: string };
type Fetch = typeof fetch;

let lastCall = 0;

const normalize = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Geocodificación acotada al territorio, con caché persistida (también de resultados vacíos) y ritmo mínimo
 * entre llamadas según la política. Proveedor: Nominatim (OSM).
 */
export async function geocode(
  db: Db,
  { query, territoryId, policy, fetchImpl = fetch }: { query: string; territoryId: string; policy: IntakePolicy["geocoder"]; fetchImpl?: Fetch },
): Promise<GeocodeHit | null> {
  const full = `${query}, ${policy.query_suffix}`;
  const key = `${territoryId}:${normalize(full)}`;
  const cached = await db.query<{ result: { hit: GeocodeHit | null } }>(
    "select result from geocode_cache where provider = $1 and query_norm = $2",
    [policy.provider, key],
  );
  if (cached.rows[0]) return cached.rows[0].result.hit;

  const bounds = await territoryBounds(db, territoryId);
  const params = new URLSearchParams({ format: "jsonv2", limit: "1", q: full, countrycodes: policy.country_codes });
  if (bounds) {
    params.set("viewbox", `${bounds.minlon},${bounds.maxlat},${bounds.maxlon},${bounds.minlat}`);
    params.set("bounded", "1");
  }
  const wait = lastCall + policy.min_interval_ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const res = await fetchImpl(`${policy.base_url}/search?${params}`, {
    headers: { "User-Agent": process.env.NOMINATIM_USER_AGENT ?? "RadarUrbano", "Accept-Language": "es" },
    signal: AbortSignal.timeout(policy.timeout_ms),
  });
  if (!res.ok) throw new Error(`geocodificador ${res.status}`);
  const body = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  const hit = body[0] ? { lon: Number(body[0].lon), lat: Number(body[0].lat), label: body[0].display_name } : null;
  await db.query(
    "insert into geocode_cache (provider, query_norm, result) values ($1, $2, $3) on conflict do nothing",
    [policy.provider, key, { hit }],
  );
  return hit;
}
