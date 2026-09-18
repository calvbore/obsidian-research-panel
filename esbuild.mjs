import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploy } from "./scripts/deploy.mjs";

const mode = process.argv[2] ?? "watch";
const production = mode === "production";
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

function seedDist() {
  mkdirSync(join(PROJECT_ROOT, "dist"), { recursive: true });
  copyFileSync(
    join(PROJECT_ROOT, "manifest.json"),
    join(PROJECT_ROOT, "dist", "manifest.json")
  );
  copyFileSync(
    join(PROJECT_ROOT, "styles.css"),
    join(PROJECT_ROOT, "dist", "styles.css")
  );
}

const plugins = [];
if (mode === "watch") {
  plugins.push({
    name: "deploy-to-vault",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        deploy();
      });
    },
  });
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: !production,
  minify: production,
  outfile: production ? "main.js" : "dist/main.js",
  plugins,
});

if (mode === "watch") {
  seedDist();
  await ctx.watch();
} else {
  if (mode === "once") seedDist();
  await ctx.rebuild();
  ctx.dispose();
}
