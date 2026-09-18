import { describe, expect, it } from "vitest";
import { Plugin } from "../../tests/mocks/obsidian";

describe("plugin entry", () => {
  it("has a default export extending Plugin", async () => {
    const mod = await import("../../src/main");
    expect(typeof mod.default).toBe("function");
    expect(Object.getPrototypeOf(mod.default)).toBe(Plugin);
  });

  it("instantiates with (app, manifest) like Obsidian does", async () => {
    const mod = await import("../../src/main");
    const instance = new mod.default(
      {} as never,
      { id: "research-panel" } as never
    );
    expect(instance).toBeInstanceOf(Plugin);
  });
});
