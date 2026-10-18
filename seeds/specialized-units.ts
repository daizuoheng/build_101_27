import type { Pool } from "pg";
import { withTx } from "../src/server/db/tx";
import { appendEvent } from "../src/server/events/append";
import type { DemoUnit } from "./demo-units";

/** Posiciones simuladas: se mantienen sin fecha hasta un refresh explícito. No crea usuarios ni contraseñas. */
export const specializedUnits: Record<string, DemoUnit[]> = {
  montevideo: [
    {
      slug: "cuadrilla-limpieza", name: "Cuadrilla Limpieza · Centro (demo)", unitKind: "mobile_crew",
      capacity: 1, capabilities: ["limpieza"],
      position: { lon: -56.1916, lat: -34.9035 }, serviceRadiusM: 3000,
    },
    {
      slug: "cuadrilla-vial", name: "Cuadrilla Vialidad y Limpieza · Carrasco (demo)", unitKind: "mobile_crew",
      capacity: 1, capabilities: ["vialidad", "limpieza"],
      position: { lon: -56.055, lat: -34.883 }, serviceRadiusM: 3000,
    },
    {
      slug: "cuadrilla-fuego", name: "Cuadrilla Fuego y Limpieza · Montevideo Shopping (demo)", unitKind: "mobile_crew",
      capacity: 1, capabilities: ["fuego", "limpieza"],
      position: { lon: -56.137, lat: -34.9017 }, serviceRadiusM: 3000,
    },
    {
      slug: "oficina-alumbrado", name: "Oficina Alumbrado · Centro y Cordón (demo)", unitKind: "zone_office",
      capacity: 5, capabilities: ["alumbrado"],
      position: { lon: -56.1882, lat: -34.9058 },
      zones: { areaExternalIds: ["51", "50"], problemTypes: ["alumbrado"], precedence: 1 },
    },
    {
      slug: "cuadrilla-arbolado", name: "Cuadrilla Arbolado · Prado (demo)", unitKind: "mobile_crew",
      capacity: 1, capabilities: ["poda"],
      position: { lon: -56.202, lat: -34.864 }, serviceRadiusM: 3000,
    },
    {
      slug: "cuadrilla-senalizacion", name: "Cuadrilla Señalización · Unión (demo)", unitKind: "mobile_crew",
      capacity: 1, capabilities: ["señalizacion"],
      position: { lon: -56.139, lat: -34.878 }, serviceRadiusM: 3000,
    },
    {
      slug: "cuadrilla-drenaje", name: "Cuadrilla Drenaje y Limpieza · Cerro (demo)", unitKind: "mobile_crew",
      capacity: 1, capabilities: ["drenaje", "limpieza"],
      position: { lon: -56.249, lat: -34.884 }, serviceRadiusM: 3000,
    },
    {
      slug: "cuadrilla-accesibilidad", name: "Cuadrilla Accesibilidad · Colón (demo)", unitKind: "mobile_crew",
      capacity: 1, capabilities: ["accesibilidad", "vialidad", "limpieza"],
      position: { lon: -56.217, lat: -34.802 }, serviceRadiusM: 3000,
    },
  ],
};

/** Inserta unidades completas en una transacción. Las existentes conservan su configuración operativa. */
export async function seedSpecializedUnits(pool: Pool, territorySlug = "montevideo"): Promise<string[]> {
  const units = specializedUnits[territorySlug];
  if (!units) throw new Error(`no hay cuadrillas configuradas para '${territorySlug}'`);
  return withTx(async (c) => {
    const t = await c.query<{ id: string }>("select id from territories where slug = $1", [territorySlug]);
    if (!t.rows[0]) throw new Error(`territorio inexistente: ${territorySlug} (correr seed primero)`);
    const territoryId = t.rows[0].id;
    const created: string[] = [];
    for (const u of units) {
      const ins = await c.query<{ id: string }>(
        `insert into response_units (territory_id, slug, name, unit_kind, capacity, location, service_radius_m, is_demo)
         values ($1, $2, $3, $4, $5, case when $6::float8 is null then null else st_setsrid(st_makepoint($6, $7), 4326)::geography end, $8, true)
         on conflict (territory_id, slug) do nothing returning id`,
        [territoryId, u.slug, u.name, u.unitKind, u.capacity, u.position?.lon ?? null, u.position?.lat ?? null, u.serviceRadiusM ?? null],
      );
      if (!ins.rows[0]) continue;
      const unitId = ins.rows[0].id;
      created.push(u.slug);
      for (const cap of u.capabilities) {
        const r = await c.query(
          "insert into unit_capabilities (unit_id, capability_id) select $1, id from capabilities where slug = $2 on conflict do nothing",
          [unitId, cap],
        );
        if (!r.rowCount) throw new Error(`capacidad inexistente: ${cap}`);
      }
      for (const ext of u.zones?.areaExternalIds ?? []) {
        for (const pt of u.zones!.problemTypes) {
          const r = await c.query(
            `insert into area_responsibilities (area_id, problem_type_id, unit_id, precedence)
             select a.id, p.id, $1, $2 from areas a, problem_types p
             where a.territory_id = $3 and a.external_id = $4 and p.slug = $5 on conflict do nothing`,
            [unitId, u.zones!.precedence, territoryId, ext, pt],
          );
          if (!r.rowCount) throw new Error(`área ${ext} o tipo ${pt} inexistente (¿import-areas?)`);
        }
      }
      await appendEvent(c, { entityType: "response_unit", entityId: unitId, kind: "demo_seeded", actorType: "system" });
    }
    return created;
  }, pool);
}
