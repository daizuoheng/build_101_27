import { describe, expect, it } from "vitest";
import { isUuid } from "@/server/ids";

describe("isUuid", () => {
  it("acepta solo UUID canónicos", () => {
    expect(isUuid("cecfb3b3-55f4-47a9-90c4-9f4e932413c5")).toBe(true);
    expect(isUuid("------------------------------------")).toBe(false);
    expect(isUuid("cecfb3b355f4-47a9-90c4-9f4e932413c5-")).toBe(false);
    expect(isUuid("cecfb3b3-55f4-47a9-90c4-9f4e932413cz")).toBe(false);
  });
});
