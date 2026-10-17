import sharp from "sharp";

export const JEV_MIN_SIDE = 280;
export const JEV_MAX_SIDE = 1568;

export type NormalizedImage = { bytes: Buffer; width: number; height: number; format: "jpeg" };

/**
 * Derivado compatible con Jev: orientación EXIF aplicada a los píxeles, JPEG baseline,
 * lado mayor ≤ 1568 y menor ≥ 280 (con relleno si la imagen es muy chica o muy alargada).
 */
export async function normalizeForJev(input: Buffer): Promise<NormalizedImage> {
  let img = sharp(input, { failOn: "error" }).rotate(); // rotate() sin argumentos aplica EXIF
  const meta = await img.metadata();
  const oriented = (meta.orientation ?? 1) >= 5;
  let w = oriented ? meta.height! : meta.width!;
  let h = oriented ? meta.width! : meta.height!;

  const scale = Math.min(1, JEV_MAX_SIDE / Math.max(w, h));
  if (scale < 1) {
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    img = img.resize(w, h, { fit: "fill" });
  }
  const padW = Math.max(0, JEV_MIN_SIDE - w);
  const padH = Math.max(0, JEV_MIN_SIDE - h);
  if (padW || padH) {
    img = img.extend({
      top: Math.floor(padH / 2), bottom: Math.ceil(padH / 2), left: Math.floor(padW / 2), right: Math.ceil(padW / 2),
      background: { r: 255, g: 255, b: 255 },
    });
    w += padW;
    h += padH;
  }
  const { data, info } = await img.flatten({ background: "#ffffff" }).jpeg({ quality: 85, progressive: false }).toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height, format: "jpeg" };
}
