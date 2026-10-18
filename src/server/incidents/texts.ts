import type { Db } from "../db/pool";
import { notFound } from "../errors";

/**
 * Textos del operador de la revisión vigente del incidente. Un propósito sin fila es `null`: el job `textgen` de esa
 * revisión todavía no corrió (o la descartó) y la vista muestra su plantilla o el `incidents.title` determinista.
 * Nunca se devuelve el texto de una revisión anterior: podría describir otra banda u otro conteo de reportes.
 */
export type IncidentTexts = { revision: number; title: string | null; summary: string | null; explain_priority: string | null };

/** Varios incidentes en una consulta, para listas. Los ids inexistentes no aparecen en el mapa. */
export async function latestTextsMany(db: Db, incidentIds: string[]): Promise<Map<string, IncidentTexts>> {
  const out = new Map<string, IncidentTexts>();
  if (!incidentIds.length) return out;
  const { rows } = await db.query<IncidentTexts & { id: string }>(
    `select i.id, i.revision,
       max(g.body) filter (where g.purpose = 'title') as title,
       max(g.body) filter (where g.purpose = 'summary') as summary,
       max(g.body) filter (where g.purpose = 'explain_priority') as explain_priority
     from incidents i
     left join generated_texts g on g.entity_type = 'incident' and g.entity_id = i.id and g.entity_revision = i.revision
     where i.id = any($1::uuid[])
     group by i.id, i.revision`,
    [incidentIds],
  );
  for (const { id, ...texts } of rows) out.set(id, texts);
  return out;
}

/** Textos de la revisión vigente de un incidente. Incidente inexistente ⇒ 404. */
export async function latestTexts(db: Db, incidentId: string): Promise<IncidentTexts> {
  const texts = (await latestTextsMany(db, [incidentId])).get(incidentId);
  if (!texts) throw notFound("Incidente inexistente.");
  return texts;
}
