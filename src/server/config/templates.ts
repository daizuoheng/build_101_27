import type { Db } from "../db/pool";

export class TemplateMissingError extends Error {
  constructor(public key: string) {
    super(`falta la plantilla '${key}'`);
  }
}

/** Plantilla del territorio o, si no hay, la global. Sustituye {{variables}}; las ausentes quedan vacías. */
export async function renderTemplate(
  db: Db,
  territoryId: string | null,
  key: string,
  vars: Record<string, string | number> = {},
  locale = "es",
): Promise<string> {
  const { rows } = await db.query<{ body: string }>(
    `select body from message_templates
     where key = $1 and locale = $2 and (territory_id = $3 or territory_id is null)
     order by territory_id nulls last limit 1`,
    [key, locale, territoryId],
  );
  if (!rows[0]) throw new TemplateMissingError(key);
  return rows[0].body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""));
}
