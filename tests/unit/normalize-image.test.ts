import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizeForJev } from "@/server/storage/normalize-image";

describe("normalizeForJev", () => {
  it("aplica EXIF y limita el lado mayor a 1568", async () => {
    // 4000×3000 apaisada con orientación 6 ⇒ se ve vertical 3000×4000
    const src = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#336699" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await normalizeForJev(src);
    expect(out.format).toBe("jpeg");
    expect(out.height).toBe(1568);
    expect(out.width).toBe(1176);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.orientation ?? 1).toBe(1);
  });

  it("rellena imágenes chicas hasta 280 por lado", async () => {
    const src = await sharp({ create: { width: 200, height: 120, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const out = await normalizeForJev(src);
    expect(out.width).toBeGreaterThanOrEqual(280);
    expect(out.height).toBeGreaterThanOrEqual(280);
  });
});
