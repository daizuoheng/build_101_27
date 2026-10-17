import type { Pool } from "pg";
import { withTx } from "../src/server/db/tx";
import { importAreas } from "../src/server/geo/import-areas";
import { activeHazardCapability, capabilities, problemTypes } from "./catalog";
import { policies } from "./policies";
import { templates } from "./templates";
import { montevideo } from "./territory-montevideo";

export const territories = [montevideo];

/**
 * Inserta lo ausente por clave natural y nunca actualiza filas existentes, así no pisa cambios de operación.
 * Reejecutable: dos corridas dejan los mismos conteos.
 */
export async function seedAll(pool: Pool, opts: { importAreas?: boolean } = {}): Promise<void> {
  await withTx(async (c) => {
    for (const cap of capabilities) {
      await c.query("insert into capabilities (slug, name) values ($1, $2) on conflict (slug) do nothing", [cap.slug, cap.name]);
    }
    for (const [i, t] of problemTypes.entries()) {
      await c.query(
        `insert into problem_types (slug, name, description, evaluation_criteria, sort_order)
         values ($1, $2, $3, $4, $5) on conflict (slug) do nothing`,
        [t.slug, t.name, t.description, t.criteria, i],
      );
      const reqs = [
        ...t.requires.map((cap) => ({ cap, condition: "always" })),
        { cap: activeHazardCapability, condition: "active_hazard" },
      ];
      for (const r of reqs) {
        await c.query(
          `insert into problem_type_requirements (problem_type_id, capability_id, condition)
           select pt.id, cap.id, $3 from problem_types pt, capabilities cap where pt.slug = $1 and cap.slug = $2
           on conflict do nothing`,
          [t.slug, r.cap, r.condition],
        );
      }
    }

    for (const terr of territories) {
      const { rows } = await c.query<{ id: string }>(
        `insert into territories (slug, name, area_label, center, default_zoom, emergency_channel, locale)
         values ($1, $2, $3, st_setsrid(st_makepoint($4, $5), 4326)::geography, $6, $7, $8)
         on conflict (slug) do update set slug = excluded.slug
         returning id`,
        [terr.slug, terr.name, terr.areaLabel, terr.center.lon, terr.center.lat, terr.defaultZoom, terr.emergencyChannel, terr.locale],
      );
      const territoryId = rows[0].id;

      await c.query(
        `insert into territory_problem_types (territory_id, problem_type_id)
         select $1, id from problem_types on conflict do nothing`,
        [territoryId],
      );

      for (const [kind, config] of Object.entries(policies)) {
        await c.query(
          `insert into policy_versions (territory_id, kind, version, config, active)
           values ($1, $2, 1, $3, not exists (select 1 from policy_versions where territory_id = $1 and kind = $2 and active))
           on conflict (territory_id, kind, version) do nothing`,
          [territoryId, kind, config],
        );
      }

      for (const t of templates) {
        await c.query(
          `insert into message_templates (territory_id, key, locale, body, variables)
           values (null, $1, $2, $3, $4) on conflict do nothing`,
          [t.key, t.locale, t.body, JSON.stringify(t.variables)],
        );
      }
    }
  }, pool);

  if (opts.importAreas !== false) {
    for (const terr of territories) {
      await importAreas(pool, { territorySlug: terr.slug, ...terr.areas });
    }
  }
}
