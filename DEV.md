# Development Guide

This project is developed inside **WSL** while Obsidian runs as a native **Windows** app with a test vault on the Windows filesystem. The dev loop deploys builds across that boundary automatically — no symlinks, no manual copying.

## How the loop works

```
save src/*.ts            (WSL, ext4 — inotify works natively)
  → esbuild rebuilds dist/main.js          (~50ms)
  → onEnd hook copies main.js, manifest.json, styles.css
    into <vault>/.obsidian/plugins/research-panel/   (/mnt/c/...)
  → Hot-Reload plugin (Windows-side) notices the mtime change
  → plugin reloads in Obsidian (~750ms debounce)
```

Why this direction and not a symlink: WSL2's inotify does not work on `/mnt/c` (9P), so *watching* Windows files from Linux is broken — but *writing* to them works fine. Sources live in ext4 (watching works), outputs go to `/mnt/c` (writes work), and Hot-Reload watches them from the Windows side where they are native files. A symlink either points the wrong way or forces Obsidian through `\\wsl$` UNC paths with unreliable watching.

## One-time setup

1. **Configure your vault path** (WSL view of the Windows test vault):

   ```bash
   echo "/mnt/c/Users/<you>/path/to/TestVault" > .vault-path.local
   ```

   `.vault-path.local` is gitignored. An `OBSIDIAN_VAULT` env var overrides it for one-off deploys:

   ```bash
   OBSIDIAN_VAULT=/mnt/c/Users/you/OtherVault npm run deploy
   ```

2. **Install Hot Reload** in the test vault: Settings → Community plugins → Browse → "Hot Reload" → Install → Enable.
   - The store serves the same release as [pjeby/hot-reload](https://github.com/pjeby/hot-reload/releases) (verified Aug 2026, v0.3.1).
   - If you ever need a newer build than the store shows, drop its release's `main.js` + `manifest.json` into `<TestVault>/.obsidian/plugins/hot-reload/`.
   - BRAT adds nothing here — it pulls the same GitHub releases the store does.

3. **Enable Research Panel once** in the test vault. Hot-Reload only reloads plugins that are enabled; after that it keeps it current automatically.

## Daily loop

```bash
npm run dev        # watch + auto-deploy on every save
```

Edit source, save, and within about a second Obsidian shows the *"Plugin research-panel has been reloaded"* notice. That's the whole loop.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Watch mode: bundle → `dist/`, deploy to vault on every rebuild |
| `npm run deploy` | One-shot fast bundle → deploy (no typecheck gate) |
| `npm run build` | Typecheck + minified production bundle at repo root (`main.js`) — never touches any vault |
| `npm test` | Run all Vitest suites (no Obsidian required) |
| `npm run typecheck` | `tsc --noEmit` over src + tests |

Production output (`main.js` + root `manifest.json` + `styles.css`) is exactly the file set GitHub releases / BRAT expect.

**Not running watch mode?** Use `npm run deploy` for a manual one-shot build + install into the test vault — Hot Reload picks it up on arrival. Plain `npm run build` only produces the release artifact and never touches any vault.

## Caveats

- **Use a scratch vault, not your daily vault.** Your Syncthing-synced vault would sync `.obsidian/plugins/research-panel/` to every device as churn. Test renames/deletes/searches in the disposable vault.
- **`.hotreload` marker**: Hot-Reload only watches plugin dirs containing `.git` or `.hotreload`. Deploy creates this marker for you; if you deploy by hand, `touch .hotreload` in the plugin folder.
- **First run after enabling**: if the panel shows nothing odd, open DevTools (`Ctrl+Shift+I`) — sourcemaps are on in dev bundles, so stack traces map back to TypeScript.
- **Deploy target validation**: deploy refuses to write unless `<vault>/.obsidian` exists, so a typo'd path fails loudly instead of scattering directories.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No reload notice after saving | Is Hot-Reload enabled? Does `<vault>/.obsidian/plugins/research-panel/.hotreload` exist? Is the plugin enabled? |
| `[deploy] no vault configured` | Create `.vault-path.local` (see setup) |
| `[deploy] ... not found ... vault root` | Path must be the vault directory itself, not its parent |
| Changes not appearing | Fallback: `Ctrl+R` in Obsidian reloads everything |
| Watch stops triggering | You're editing files under `/mnt/c` — keep sources in WSL's ext4 |

## Distribution (later)

Once this repo is pushed to GitHub:

1. Tag a release; attach `main.js`, `manifest.json`, `styles.css` (release tag must match `manifest.json` version).
2. Anyone can then install via [BRAT](https://github.com/TfThacker/obsidian42-brat): BRAT → Add Beta Plugin → `user/repo`.
3. BRAT is for **consuming** builds — it pulls from GitHub on an interval and is not suitable for the edit-save-see loop above.
