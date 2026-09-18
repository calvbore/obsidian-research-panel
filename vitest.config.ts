import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const obsidianStub = fileURLToPath(
  new URL("./tests/mocks/obsidian.ts", import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: {
      obsidian: obsidianStub,
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
