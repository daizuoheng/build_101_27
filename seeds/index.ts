import type { Pool } from "pg";
import { withTx } from "../src/server/db/tx";
import { importAreas } from "../src/server/geo/import-areas";
import { isValidPolicy, type PolicyKind } from "../src/server/config/policies";
import { activeHazardCapability, capabilities, problemTypes } from "./catalog";
import { policies } from "./policies";
import { templates } from "./templates";
import { montevideo } from "./territory-montevideo";

export const territories = [montevideo];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * La política del seed con las secciones de primer nivel que ya tenía la guardada, cada una entera: no se mezclan
 * por dentro (una clave quitada de un mapa como `strategies` sigue quitada) y se descartan las que el seed ya no tiene.
 */
function fillMissing(seed: unknown, stored: unknown): unknown {
  if (!isObject(seed) || !isObject(stored)) return seed;
  return Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, k in stored ? stored[k] : v]));
}

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

      for (const [kind, config] of Object.entries(policies) as [PolicyKind, unknown][]) {
        if (!isValidPolicy(kind, config)) throw new Error(`la política '${kind}' del seed no valida contra su esquema`);
        // Mismo lock que policy-upgrade y el seed de demo-b: serializa el cálculo de la versión siguiente.
        await c.query("select pg_advisory_xact_lock(hashtext($1))", [`policy:${territoryId}:${kind}`]);
        await c.query(
          `insert into policy_versions (territory_id, kind, version, config, active)
           values ($1, $2, 1, $3, not exists (select 1 from policy_versions where territory_id = $1 and kind = $2 and active))
           on conflict (territory_id, kind, version) do nothing`,
          [territoryId, kind, config],
        );
        // Si no queda ninguna activa, o el esquema cambió y la activa ya no valida, se publica una versión nueva:
        // se versiona, no se edita, y una política válida (aunque la haya cambiado operación) no se toca.
        // Sobre una activa inválida se conservan sus secciones y el seed completa las que faltan; si aun así no valida, va la del seed.
        const active = await c.query<{ version: number; config: unknown }>(
          "select version, config from policy_versions where territory_id = $1 and kind = $2 and active",
          [territoryId, kind],
        );
        const current = active.rows[0]?.config;
        if (current === undefined || !isValidPolicy(kind, current)) {
          const merged = current === undefined ? config : fillMissing(config, current);
          const next = isValidPolicy(kind, merged) ? merged : config;
          await c.query("update policy_versions set active = false where territory_id = $1 and kind = $2 and active", [territoryId, kind]);
          await c.query(
            `insert into policy_versions (territory_id, kind, version, config, active)
             select $1, $2, coalesce(max(version), 0) + 1, $3, true from policy_versions where territory_id = $1 and kind = $2`,
            [territoryId, kind, next],
          );
        }
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
