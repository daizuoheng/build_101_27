// Segundo territorio SINTÉTICO, solo para tests: prueba que Montevideo es configuración y no código.
// No entra en seedAll. Un cuadrado de ~1 km en el golfo de Guinea (0°, 0°), lejos de cualquier dato real.
import type { Pool } from "pg";
import { isValidPolicy, type PolicyKind } from "../src/server/config/policies";
import { withTx } from "../src/server/db/tx";
import { appendEvent } from "../src/server/events/append";
import type { DemoUnit } from "./demo-units";
import { policies } from "./policies";

export const demoB = {
  slug: "demo-b",
  name: "Territorio de prueba B",
  areaLabel: "Sector",
  center: { lon: 0.005, lat: 0.005 },
  defaultZoom: 15,
  locale: "es",
  emergencyChannel: { text: "canal de emergencias de prueba." },
  /** Cobertura del territorio y geometría de su única área. */
  square: { minLon: 0, minLat: 0, maxLon: 0.01, maxLat: 0.01 },
  area: { externalId: "sector-unico", name: "Sector único" },
  /** Catálogo propio: solo dos tipos habilitados. */
  problemTypes: ["bache", "basura_acumulada"],
  /**
   * Políticas del seed con diferencias visibles, para comprobar que se leen por territorio. El geocodificador
   * no apunta a Montevideo: el cuadrado está en el mar y no tiene país. Los textos de las preguntas a Jev siguen
   * diciendo "(Spanish, Uruguay)": ver la nota del segundo territorio.
   */
  policies: {
    ...policies,
    intake: { ...policies.intake, geocoder: { ...policies.intake.geocoder, country_codes: "", query_suffix: "Territorio de prueba B" } },
    grouping: { ...policies.grouping, radius_m: 75 },
    textgen: { ...policies.textgen, enabled: false },
  },
  unit: {
    slug: "cuadrilla-b",
    name: "Cuadrilla B (prueba)",
    unitKind: "mobile_crew" as DemoUnit["unitKind"],
    capacity: 1,
    capabilities: ["vialidad", "limpieza"],
    position: { lon: 0.004, lat: 0.004 },
    serviceRadiusM: 2000,
  },
};

export type DemoB = typeof demoB;

/**
 * Requiere `seedAll` antes (catálogo y capacidades globales). Reejecutable y convergente: a diferencia de
 * `seedAll`, que nunca pisa lo que pudo cambiar operación, demo-b es sintético y no tiene operación, así que
 * cada corrida deja los valores como dice `demoB` (con `overrides` encima; los tests lo usan para simular un
 * cambio). Converge por clave natural: renombrar el slug de la unidad o el `externalId` del área crea filas
 * nuevas y no borra las viejas (pueden tener incidentes u órdenes que las referencian).
 * No toca el estado de la unidad ni le pone fecha de posición: eso es `refreshDemoPositions`.
 */
export async function seedTerritoryDemoB(pool: Pool, overrides: Partial<DemoB> = {}): Promise<{ territoryId: string; unitId: string }> {
  const t = { ...demoB, ...overrides };
  // Todas las políticas se validan antes de escribir nada.
  const policyEntries = Object.entries(t.policies) as [PolicyKind, unknown][];
  for (const [kind, config] of policyEntries) {
    if (!isValidPolicy(kind, config)) throw new Error(`la política '${kind}' de demo-b no valida contra su esquema`);
  }
  const sq = t.square;
  const env = "st_multi(st_makeenvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326))";
  const sqParams = [sq.minLon, sq.minLat, sq.maxLon, sq.maxLat];
  return withTx(async (c) => {
    const terr = await c.query<{ id: string }>(
      `insert into territories (slug, name, area_label, center, default_zoom, coverage, emergency_channel, locale)
       values ($5, $6, $7, st_setsrid(st_makepoint($8, $9), 4326)::geography, $10, ${env}, $11, $12)
       on conflict (slug) do update set name = excluded.name, area_label = excluded.area_label, center = excluded.center,
         default_zoom = excluded.default_zoom, coverage = excluded.coverage, emergency_channel = excluded.emergency_channel,
         locale = excluded.locale, enabled = true, updated_at = now()
       returning id`,
      [...sqParams, t.slug, t.name, t.areaLabel, t.center.lon, t.center.lat, t.defaultZoom, t.emergencyChannel, t.locale],
    );
    const territoryId = terr.rows[0].id;
    await c.query(
      `insert into areas (territory_id, external_id, name, geom, source_url, source_date, checksum)
       values ($5, $6, $7, ${env}, 'synthetic', current_date, 'synthetic')
       on conflict (territory_id, external_id) do update set name = excluded.name, geom = excluded.geom`,
      [...sqParams, territoryId, t.area.externalId, t.area.name],
    );

    // Catálogo: habilita los tipos de la lista y deshabilita los que salieron de ella. Se valida antes de
    // escribir, y solo cuentan los tipos activos, como en `getActiveCatalog`.
    const knownTypes = await c.query<{ n: number }>("select count(*)::int as n from problem_types where slug = any($1) and active", [t.problemTypes]);
    const missing = new Set(t.problemTypes).size - knownTypes.rows[0].n;
    if (missing) throw new Error(`catálogo de demo-b incompleto: ${missing} tipo(s) inexistentes o inactivos (¿falta seedAll?)`);
    await c.query(
      `insert into territory_problem_types (territory_id, problem_type_id)
       select $1, id from problem_types where slug = any($2) and active
       on conflict (territory_id, problem_type_id) do update set enabled = true`,
      [territoryId, t.problemTypes],
    );
    await c.query(
      `update territory_problem_types set enabled = false where territory_id = $1 and enabled
         and problem_type_id not in (select id from problem_types where slug = any($2))`,
      [territoryId, t.problemTypes],
    );

    // Políticas: si la activa falta o difiere de la del seed, se publica la del seed como versión nueva activa.
    // Se versiona y no se edita (como `policy-upgrade`): evaluaciones y decisiones guardan el `policy_version_id`
    // con que se calcularon, y editar esa fila reescribiría su traza. El lock es el mismo de `policy-upgrade`,
    // para que dos publicaciones del mismo kind no choquen en `max(version) + 1`.
    for (const [kind, config] of policyEntries) {
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [`policy:${territoryId}:${kind}`]);
      const active = await c.query<{ same: boolean }>(
        "select config = $3::jsonb as same from policy_versions where territory_id = $1 and kind = $2 and active",
        [territoryId, kind, config],
      );
      if (active.rows[0]?.same) continue;
      await c.query("update policy_versions set active = false where territory_id = $1 and kind = $2 and active", [territoryId, kind]);
      await c.query(
        `insert into policy_versions (territory_id, kind, version, config, active)
         select $1, $2, coalesce(max(version), 0) + 1, $3, true from policy_versions where territory_id = $1 and kind = $2`,
        [territoryId, kind, config],
      );
    }

    // Unidad: un solo upsert. Una posición nueva no hereda la vigencia de la anterior: si cambió, se borra su fecha.
    // `xmax = 0` distingue la fila recién insertada, la única que registra `demo_seeded` (como `seedDemo`).
    const u = t.unit;
    const unit = await c.query<{ id: string; inserted: boolean }>(
      `insert into response_units (territory_id, slug, name, unit_kind, capacity, location, service_radius_m, is_demo)
       values ($1, $2, $3, $4, $5, st_setsrid(st_makepoint($6, $7), 4326)::geography, $8, true)
       on conflict (territory_id, slug) do update set name = excluded.name, unit_kind = excluded.unit_kind,
         capacity = excluded.capacity, service_radius_m = excluded.service_radius_m, is_demo = true, updated_at = now(),
         location_updated_at = case when st_equals(response_units.location::geometry, excluded.location::geometry)
           then response_units.location_updated_at end,
         location = excluded.location
       returning id, (xmax = 0) as inserted`,
      [territoryId, u.slug, u.name, u.unitKind, u.capacity, u.position.lon, u.position.lat, u.serviceRadiusM],
    );
    const unitId = unit.rows[0].id;
    if (unit.rows[0].inserted) {
      await appendEvent(c, { entityType: "response_unit", entityId: unitId, kind: "demo_seeded", actorType: "system" });
    }

    // Capacidades: exactamente las de la lista. Se valida antes de escribir, como el catálogo.
    const known = await c.query<{ n: number }>("select count(*)::int as n from capabilities where slug = any($1)", [u.capabilities]);
    const missingCaps = new Set(u.capabilities).size - known.rows[0].n;
    if (missingCaps) throw new Error(`capacidades de demo-b incompletas: ${missingCaps} inexistente(s) (¿falta seedAll?)`);
    await c.query(
      "delete from unit_capabilities where unit_id = $1 and capability_id not in (select id from capabilities where slug = any($2))",
      [unitId, u.capabilities],
    );
    await c.query(
      "insert into unit_capabilities (unit_id, capability_id) select $1, id from capabilities where slug = any($2) on conflict do nothing",
      [unitId, u.capabilities],
    );
    return { territoryId, unitId };
  }, pool);
}
