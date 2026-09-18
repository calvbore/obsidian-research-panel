import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(PROJECT_ROOT, "dist");
const PLUGIN_ID = "research-panel";
const PATH_FILE = join(PROJECT_ROOT, ".vault-path.local");
const DEPLOY_FILES = ["main.js", "manifest.json", "styles.css"];

export function resolveVaultPath() {
  const fromEnv = process.env.OBSIDIAN_VAULT?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(PATH_FILE)) {
    const fromFile = readFileSync(PATH_FILE, "utf8").trim();
    if (fromFile) return fromFile;
  }
  return null;
}

export function deploy(log = console.log) {
  const vaultPath = resolveVaultPath();
  if (!vaultPath) {
    log(
      "[deploy] no vault configured.\n" +
        `  Create ${PATH_FILE} containing your vault's WSL path\n` +
        "  (e.g. /mnt/c/Users/you/TestVault), or export OBSIDIAN_VAULT."
    );
    return false;
  }

  const obsidianDir = join(vaultPath, ".obsidian");
  if (!existsSync(obsidianDir)) {
    log(
      `[deploy] ${obsidianDir} not found.\n` +
        `  "${vaultPath}" does not look like a vault root.`
    );
    return false;
  }

  for (const file of DEPLOY_FILES) {
    if (!existsSync(join(DIST_DIR, file))) {
      log(`[deploy] dist/${file} missing — build first.`);
      return false;
    }
  }

  const pluginDir = join(obsidianDir, "plugins", PLUGIN_ID);
  mkdirSync(pluginDir, { recursive: true });
  for (const file of DEPLOY_FILES) {
    cpSync(join(DIST_DIR, file), join(pluginDir, file));
  }
  writeFileSync(join(pluginDir, ".hotreload"), "");
  log(`[deploy] -> ${pluginDir}`);
  return true;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  process.exit(deploy() ? 0 : 1);
}
