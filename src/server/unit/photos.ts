import { isUuid } from "../ids";
import type { Db } from "../db/pool";
import { notFound } from "../errors";
import type { StorageAdapter } from "../storage/adapter";
import { ACTIVE_ASSIGNMENT_STATUSES } from "@/shared/contracts/assignment";

/**
 * Foto de evidencia para una unidad: solo si pertenece a un reporte vinculado (activo) a un incidente con una orden
 * activa de esa unidad. Se sirve el derivado JPEG. Responde 404 (no 403) para no revelar qué ids existen.
 */
export async function getUnitPhoto(
  db: Db,
  storage: StorageAdapter,
  { unitId, attachmentId }: { unitId: string; attachmentId: string },
): Promise<Buffer> {
  if (!isUuid(attachmentId)) throw notFound("Foto inexistente.");
  const { rows } = await db.query<{ storage_key: string }>(
    `select d.storage_key
     from attachments a
     join attachments d on d.report_id = a.report_id and d.purpose = 'jev' and (d.id = a.id or d.derived_from_id = a.id)
     join report_incident_links l on l.report_id = a.report_id and l.active
     join assignments s on s.incident_id = l.incident_id and s.unit_id = $2 and s.status = any($3)
     where a.id = $1
     limit 1`,
    [attachmentId, unitId, ACTIVE_ASSIGNMENT_STATUSES],
  );
  if (!rows[0]) throw notFound("Foto inexistente.");
  return storage.get(rows[0].storage_key);
}
