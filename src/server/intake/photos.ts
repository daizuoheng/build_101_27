import sharp from "sharp";
import { isUuid } from "../ids";
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
  { reportId, sessionId, attachmentId, size = "full" }: { reportId: string; sessionId: string; attachmentId: string; size?: PhotoSize },
): Promise<Buffer> {
  if (!isUuid(attachmentId)) throw notFound("Foto inexistente.");
  await getOwnedReport(db, reportId, sessionId);
  const { rows } = await db.query<{ storage_key: string }>(
    `select storage_key from attachments
     where report_id = $1 and purpose = 'jev' and (id = $2 or derived_from_id = $2) limit 1`,
    [reportId, attachmentId],
  );
  if (!rows[0]) throw notFound("Foto inexistente.");
  return readPhoto(storage, rows[0].storage_key, size);
}

/** Tamaños servidos. `thumb`: miniatura cuadrada para el chat y la bandeja (≈ 15 KB en vez de cientos). */
export type PhotoSize = "thumb" | "full";
export const photoSize = (v: string | null): PhotoSize => (v === "thumb" ? "thumb" : "full");

/** Recorta y achica el derivado para miniaturas (240 px cubre 2× de una miniatura de 80–120 px). */
export async function renderPhoto(bytes: Buffer, size: PhotoSize): Promise<Buffer> {
  if (size === "full") return bytes;
  return sharp(bytes).resize(240, 240, { fit: "cover" }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
}

/**
 * Lee el derivado; para `thumb` usa la miniatura guardada junto al derivado (`<clave>.thumb.jpg`) y, si todavía no
 * existe, la genera una vez y la guarda. Así cada miniatura se recodifica una sola vez, también para fotos viejas.
 * Si guardarla falla, igual se sirve (queda para el próximo pedido).
 */
export async function readPhoto(storage: StorageAdapter, derivedKey: string, size: PhotoSize): Promise<Buffer> {
  if (size === "full") return storage.get(derivedKey);
  const thumbKey = `${derivedKey}.thumb.jpg`;
  try {
    const cached = await storage.get(thumbKey);
    if (cached?.length) return cached;
    throw new Error("sin miniatura");
  } catch {
    const thumb = await renderPhoto(await storage.get(derivedKey), "thumb");
    await storage.put(thumbKey, thumb, "image/jpeg").catch(() => {});
    return thumb;
  }
}
