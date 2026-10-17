import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { photoSize, renderPhoto } from "@/server/intake/photos";

describe("renderPhoto", () => {
  it("thumb ⇒ JPEG 240×240 mucho más liviano; full ⇒ los mismos bytes", async () => {
    const big = await sharp({ create: { width: 1568, height: 1176, channels: 3, background: "#887766" } }).jpeg({ quality: 92 }).toBuffer();
    const thumb = await renderPhoto(big, "thumb");
    const meta = await sharp(thumb).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([240, 240, "jpeg"]);
    expect(thumb.length).toBeLessThan(big.length);
    expect(await renderPhoto(big, "full")).toBe(big);
  });
  it("cualquier otro valor ⇒ full", () => {
    expect(photoSize("thumb")).toBe("thumb");
    expect(photoSize(null)).toBe("full");
    expect(photoSize("../../etc")).toBe("full");
  });
});
