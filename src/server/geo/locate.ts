import type { Db } from "../db/pool";

export type Located = { territoryId: string; territorySlug: string; areaId: string | null; areaName: string | null };

/**
 * Territorio por cobertura (`territories.coverage` o, si no hay, la unión de sus áreas) y área por punto en polígono.
 * Sin coincidencia de área devuelve `areaId = null` («sin determinar»); nunca el área más cercana.
 */
export async function locatePoint(db: Db, lon: number, lat: number): Promise<Located | null> {
  const { rows } = await db.query<Located>(
    `with p as (select st_setsrid(st_makepoint($1, $2), 4326) as g)
     select t.id as "territoryId", t.slug as "territorySlug", a.id as "areaId", a.name as "areaName"
     from territories t
     cross join p
     left join lateral (
       select a.id, a.name from areas a
       where a.territory_id = t.id and st_contains(a.geom, p.g)
       order by a.external_id limit 1
     ) a on true
     where t.enabled and (
       (t.coverage is not null and st_contains(t.coverage, p.g))
       or (t.coverage is null and exists (select 1 from areas x where x.territory_id = t.id and st_contains(x.geom, p.g)))
     )
     order by t.slug limit 1`,
    [lon, lat],
  );
  return rows[0] ?? null;
}

/** Caja envolvente de las áreas de un territorio, para acotar el geocodificador. */
export async function territoryBounds(db: Db, territoryId: string) {
  const { rows } = await db.query<{ minlon: number; minlat: number; maxlon: number; maxlat: number }>(
    `select st_xmin(e) as minlon, st_ymin(e) as minlat, st_xmax(e) as maxlon, st_ymax(e) as maxlat
     from (select st_extent(geom) as e from areas where territory_id = $1) s where e is not null`,
    [territoryId],
  );
  return rows[0] ?? null;
}
