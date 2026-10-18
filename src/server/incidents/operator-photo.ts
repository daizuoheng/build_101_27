import type { Db } from "../db/pool";
import { notFound } from "../errors";
import { isUuid } from "../ids";
import { readPhoto, type PhotoSize } from "../intake/photos";
import type { StorageAdapter } from "../storage/adapter";

/**
 * Foto de evidencia para el operador: solo si el adjunto es de un reporte confirmado de su territorio (los borradores
 * siguen siendo del ciudadano). Se sirve el derivado JPEG, como a la unidad. 404 (no 403) si no: no revela qué ids existen.
 */
export async function getOperatorPhoto(
  db: Db,
  storage: StorageAdapter,
  { territoryId, attachmentId, size = "full" }: { territoryId: string; attachmentId: string; size?: PhotoSize },
): Promise<Buffer> {
  if (!isUuid(attachmentId)) throw notFound("Foto inexistente.");
  const { rows } = await db.query<{ storage_key: string }>(
    `select d.storage_key
     from attachments a
     join reports r on r.id = a.report_id and r.territory_id = $2 and r.status = 'confirmed'
     join attachments d on d.report_id = a.report_id and d.purpose = 'jev' and (d.id = a.id or d.derived_from_id = a.id)
     where a.id = $1
     limit 1`,
    [attachmentId, territoryId],
  );
  if (!rows[0]) throw notFound("Foto inexistente.");
  return readPhoto(storage, rows[0].storage_key, size);
}
