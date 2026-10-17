import type { Db } from "../db/pool";
import { notFound } from "../errors";
import type { StorageAdapter } from "../storage/adapter";
import { getOwnedReport } from "./drafts";

/**
 * Foto de un borrador/reporte para su dueño. Se sirve el derivado JPEG normalizado (el original puede ser HEIC,
 * que la mayoría de los navegadores no muestra). `attachmentId` puede ser el original o el derivado.
 */
export async function getOwnPhoto(
  db: Db,
  storage: StorageAdapter,
  { reportId, sessionId, attachmentId }: { reportId: string; sessionId: string; attachmentId: string },
): Promise<Buffer> {
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw notFound("Foto inexistente.");
  await getOwnedReport(db, reportId, sessionId);
  const { rows } = await db.query<{ storage_key: string }>(
    `select storage_key from attachments
     where report_id = $1 and purpose = 'jev' and (id = $2 or derived_from_id = $2) limit 1`,
    [reportId, attachmentId],
  );
  if (!rows[0]) throw notFound("Foto inexistente.");
  return storage.get(rows[0].storage_key);
}
