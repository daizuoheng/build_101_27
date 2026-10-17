import { createHash } from "node:crypto";
import type { Db } from "../db/pool";

export type CatalogType = { id: string; slug: string; name: string; description: string; criteria: unknown };

/** Catálogo activo y habilitado para el territorio, con hash estable para invalidar evaluaciones. */
export async function getActiveCatalog(db: Db, territoryId: string): Promise<{ types: CatalogType[]; hash: string }> {
  const { rows } = await db.query<CatalogType>(
    `select pt.id, pt.slug, pt.name, pt.description, pt.evaluation_criteria as criteria
     from problem_types pt
     join territory_problem_types tpt on tpt.problem_type_id = pt.id and tpt.territory_id = $1 and tpt.enabled
     where pt.active
     order by pt.sort_order, pt.slug`,
    [territoryId],
  );
  const hash = createHash("sha256")
    .update(JSON.stringify(rows.map((r) => [r.slug, r.name, r.criteria])))
    .digest("hex")
    .slice(0, 16);
  return { types: rows, hash };
}
