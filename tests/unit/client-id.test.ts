import { afterEach, describe, expect, it, vi } from "vitest";
import { newClientId } from "@/app/_components/ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newClientId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fuera de contexto seguro (sin crypto.randomUUID) arma un UUID v4 con getRandomValues", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    const ids = Array.from({ length: 50 }, () => newClientId());
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(50);
  });

  it("con crypto.randomUUID lo usa", () => {
    expect(newClientId()).toMatch(UUID_V4);
  });
});
