// Segundo territorio SINTÉTICO, solo para tests: prueba que Montevideo es configuración y no código.
// No entra en seedAll. Un cuadrado de ~1 km en el golfo de Guinea (0°, 0°), lejos de cualquier dato real.
import type { Pool } from "pg";
import { isValidPolicy, type PolicyKind } from "../src/server/config/policies";
import { withTx } from "../src/server/db/tx";
import { policies } from "./policies";

const SQUARE = { minLon: 0, minLat: 0, maxLon: 0.01, maxLat: 0.01 };

export const demoB = {
  slug: "demo-b",
  name: "Territorio de prueba B",
  areaLabel: "Sector",
  center: { lon: 0.005, lat: 0.005 },
  defaultZoom: 15,
  locale: "es",
  emergencyChannel: { text: "canal de emergencias de prueba." },
  square: SQUARE,
  area: { externalId: "sector-unico", name: "Sector único" },
  /** Catálogo propio: solo dos tipos habilitados. */
  problemTypes: ["bache", "basura_acumulada"],
  /** Políticas del seed con diferencias visibles, para comprobar que se leen por territorio. */
  policies: {
    ...policies,
    grouping: { ...policies.grouping, radius_m: 75 },
    textgen: { ...policies.textgen, enabled: false },
  },
  unit: {
    slug: "cuadrilla-b",
    name: "Cuadrilla B (prueba)",
    unitKind: "mobile_crew",
    capacity: 1,
    capabilities: ["vialidad", "limpieza"],
    position: { lon: 0.004, lat: 0.004 },
    serviceRadiusM: 2000,
  },
};

/**
 * Requiere `seedAll` antes (catálogo y capacidades globales). Idempotente por clave natural.
 * `opts.policies` reemplaza por kind las políticas de `demoB` (los tests lo usan para simular un cambio de config).
 */
export async function seedTerritoryDemoB(
  pool: Pool,
  opts: { policies?: Partial<Record<PolicyKind, unknown>> } = {},
): Promise<{ territoryId: string; unitId: string }> {
  const t = demoB;
  const env = `st_multi(st_makeenvelope(${SQUARE.minLon}, ${SQUARE.minLat}, ${SQUARE.maxLon}, ${SQUARE.maxLat}, 4326))`;
  return withTx(async (c) => {
    const terr = await c.query<{ id: string }>(
      `insert into territories (slug, name, area_label, center, default_zoom, coverage, emergency_channel, locale)
       values ($1, $2, $3, st_setsrid(st_makepoint($4, $5), 4326)::geography, $6, ${env}, $7, $8)
       on conflict (slug) do update set slug = excluded.slug returning id`,
      [t.slug, t.name, t.areaLabel, t.center.lon, t.center.lat, t.defaultZoom, t.emergencyChannel, t.locale],
    );
    const territoryId = terr.rows[0].id;
    await c.query(
      `insert into areas (territory_id, external_id, name, geom, source_url, source_date, checksum)
       values ($1, $2, $3, ${env}, 'synthetic', current_date, 'synthetic') on conflict (territory_id, external_id) do nothing`,
      [territoryId, t.area.externalId, t.area.name],
    );
    await c.query(
      `insert into territory_problem_types (territory_id, problem_type_id)
       select $1, id from problem_types where slug = any($2) on conflict do nothing`,
      [territoryId, t.problemTypes],
    );
    const enabled = await c.query<{ n: number }>("select count(*)::int as n from territory_problem_types where territory_id = $1", [territoryId]);
    if (enabled.rows[0].n !== t.problemTypes.length) throw new Error("catálogo de demo-b incompleto (¿falta seedAll?)");
    // demo-b es sintético y su única fuente de verdad es este archivo: si la política activa falta o difiere
    // de la del seed, se publica la del seed como versión nueva activa. Se versiona y no se edita (como
    // `policy-upgrade`), porque evaluaciones y decisiones guardan el `policy_version_id` con que se calcularon.
    for (const [kind, config] of Object.entries({ ...t.policies, ...opts.policies }) as [PolicyKind, unknown][]) {
      if (!isValidPolicy(kind, config)) throw new Error(`la política '${kind}' de demo-b no valida contra su esquema`);
      const active = await c.query<{ same: boolean }>(
        "select config = $3::jsonb as same from policy_versions where territory_id = $1 and kind = $2 and active",
        [territoryId, kind, JSON.stringify(config)],
      );
      if (active.rows[0]?.same) continue;
      await c.query("update policy_versions set active = false where territory_id = $1 and kind = $2 and active", [territoryId, kind]);
      await c.query(
        `insert into policy_versions (territory_id, kind, version, config, active)
         select $1, $2, coalesce(max(version), 0) + 1, $3, true from policy_versions where territory_id = $1 and kind = $2`,
        [territoryId, kind, JSON.stringify(config)],
      );
    }
    const u = t.unit;
    await c.query(
      `insert into response_units (territory_id, slug, name, unit_kind, capacity, location, location_updated_at, service_radius_m, is_demo)
       values ($1, $2, $3, $4, $5, st_setsrid(st_makepoint($6, $7), 4326)::geography, now(), $8, true)
       on conflict (territory_id, slug) do nothing`,
      [territoryId, u.slug, u.name, u.unitKind, u.capacity, u.position.lon, u.position.lat, u.serviceRadiusM],
    );
    const unitId = (await c.query<{ id: string }>("select id from response_units where territory_id = $1 and slug = $2", [territoryId, u.slug])).rows[0].id;
    const caps = await c.query(
      "insert into unit_capabilities (unit_id, capability_id) select $1, id from capabilities where slug = any($2) on conflict do nothing returning 1",
      [unitId, u.capabilities],
    );
    const linked = await c.query<{ n: number }>("select count(*)::int as n from unit_capabilities where unit_id = $1", [unitId]);
    if (linked.rows[0].n !== u.capabilities.length) throw new Error(`capacidades de demo-b incompletas (${caps.rowCount} nuevas)`);
    return { territoryId, unitId };
  }, pool);
}
