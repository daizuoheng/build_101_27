import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { photoSize, readPhoto, renderPhoto } from "@/server/intake/photos";
import type { StorageAdapter } from "@/server/storage/adapter";

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

describe("readPhoto", () => {
  it("la miniatura se genera una vez y después se lee de storage", async () => {
    const big = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    const m = new Map<string, Buffer>([["r/x-jev.jpg", big]]);
    let puts = 0;
    const storage: StorageAdapter = {
      put: async (k, b) => { puts++; m.set(k, b); },
      get: async (k) => { const b = m.get(k); if (!b) throw new Error("ENOENT"); return b; },
    };
    const a = await readPhoto(storage, "r/x-jev.jpg", "thumb");
    const b = await readPhoto(storage, "r/x-jev.jpg", "thumb");
    expect(puts).toBe(1);
    expect(b.equals(a)).toBe(true);
    expect(m.has("r/x-jev.jpg.thumb.jpg")).toBe(true);
    expect(await readPhoto(storage, "r/x-jev.jpg", "full")).toBe(big);
  });
});

describe("readPhoto: errores y concurrencia", () => {
  const big = () => sharp({ create: { width: 400, height: 300, channels: 3, background: "#aa5500" } }).jpeg().toBuffer();

  it("una falla real del storage se propaga sin recodificar", async () => {
    const src = await big();
    let reads = 0;
    const storage: StorageAdapter = {
      put: async () => {},
      get: async (k) => {
        reads++;
        if (k.endsWith(".thumb.jpg")) throw new Error("Supabase Storage get 503");
        return src;
      },
    };
    await expect(readPhoto(storage, "a-jev.jpg", "thumb")).rejects.toThrow(/503/);
    expect(reads).toBe(1); // no leyó el derivado para recodificar
  });

  it("pedidos simultáneos de una miniatura nueva la generan una sola vez", async () => {
    const src = await big();
    const m = new Map<string, Buffer>([["b-jev.jpg", src]]);
    let puts = 0;
    let derivedReads = 0;
    const storage: StorageAdapter = {
      put: async (k, b) => { puts++; m.set(k, b); },
      get: async (k) => {
        const b = m.get(k);
        if (!b) throw Object.assign(new Error("no existe"), { code: "ENOENT" });
        if (k === "b-jev.jpg") derivedReads++;
        return b;
      },
    };
    const all = await Promise.all(Array.from({ length: 8 }, () => readPhoto(storage, "b-jev.jpg", "thumb")));
    expect(puts).toBe(1);
    expect(derivedReads).toBe(1);
    expect(all.every((b) => b.equals(all[0]))).toBe(true);
  });
});
