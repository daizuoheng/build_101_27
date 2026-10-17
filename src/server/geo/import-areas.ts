import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { withTx } from "../db/tx";

export type ImportAreasInput = {
  territorySlug: string;
  file: string;
  nameProperty: string;
  idProperty: string;
  sourceUrl?: string;
  sourceDate?: string;
};

/**
 * Importa subdivisiones desde GeoJSON. El mapeo de propiedades es configuración de la fuente, no del sistema.
 * Reimportar el mismo archivo no cambia nada; un archivo corregido (otro checksum) actualiza geometría y nombre.
 * Los incidentes ya localizados conservan su área hasta que se reevalúen.
 */
export async function importAreas(pool: Pool, input: ImportAreasInput): Promise<{ inserted: number; updated: number; total: number }> {
  const raw = await readFile(input.file);
  const checksum = createHash("sha256").update(raw).digest("hex");
  const geojson = JSON.parse(raw.toString("utf8")) as {
    features: { properties: Record<string, unknown>; geometry: unknown }[];
  };

  return withTx(async (c) => {
    const t = await c.query<{ id: string }>("select id from territories where slug = $1", [input.territorySlug]);
    if (!t.rows[0]) throw new Error(`territorio inexistente: ${input.territorySlug}`);
    const territoryId = t.rows[0].id;
    let inserted = 0;
    let updated = 0;
    for (const f of geojson.features) {
      const externalId = String(f.properties[input.idProperty]);
      const name = String(f.properties[input.nameProperty] ?? "").trim();
      const res = await c.query<{ inserted: boolean }>(
        `insert into areas (territory_id, external_id, name, geom, source_url, source_date, checksum)
         values ($1, $2, $3, st_setsrid(st_multi(st_geomfromgeojson($4)), 4326), $5, $6, $7)
         on conflict (territory_id, external_id) do update set name = excluded.name, geom = excluded.geom,
           source_url = excluded.source_url, source_date = excluded.source_date, checksum = excluded.checksum
           where areas.checksum is distinct from excluded.checksum
         returning (xmax = 0) as inserted`,
        [territoryId, externalId, name, JSON.stringify(f.geometry), input.sourceUrl ?? null, input.sourceDate ?? null, checksum],
      );
      if (res.rows[0]?.inserted) inserted++;
      else if (res.rows[0]) updated++;
    }
    const total = await c.query<{ n: number }>("select count(*)::int as n from areas where territory_id = $1", [territoryId]);
    return { inserted, updated, total: total.rows[0].n };
  }, pool);
}
