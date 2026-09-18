# AGENTS.md

Obsidian plugin ("Research Panel"): TypeScript + esbuild, Vitest tests. No Obsidian app or vault needed for tests/typecheck.

## Commands

| Command | Notes |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/` + `tests/` |
| `npm test` | All suites, runs in ~1s. Single suite: `npx vitest run tests/unit/llmService.test.ts` |
| `npm run build` | Typecheck gate + minified release bundle to root `main.js` |
| `npm run deploy` | One-shot bundle + install into test vault — **no typecheck gate** |
| `npm run dev` | Watch mode; auto-deploys to vault on every save |

Verify with `npm run typecheck && npm test` before committing. Test files must live under `tests/**/*.test.ts` (vitest `include` pattern) or they are silently not run.

## Side effects: dev/deploy write to the user's Obsidian vault

- `npm run dev` / `npm run deploy` copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/research-panel/`. Vault path comes from `.vault-path.local` (gitignored, machine-local) or `OBSIDIAN_VAULT` env var; deploy fails loudly if the target isn't a vault root.
- This repo is developed in **WSL** against a **Windows** vault. Sources must stay on ext4 (inotify doesn't work on `/mnt/c`); deploy writes across the boundary by design. Don't move sources or "fix" this with symlinks — see `DEV.md` for why.
- Don't edit root `main.js` — it's a build artifact (gitignored). Entry point is `src/main.ts`.
- `dist/` is dev-bundle output (gitignored); `npm run build` emits root `main.js` + `manifest.json` + `styles.css`, which is the exact GitHub-release file set. Release tag must match `manifest.json` version.

## Architecture

- Entry: `src/main.ts` (`ResearchPanelPlugin`) wires settings, the panel view, and vault rename/delete handlers.
- Layering: `src/adapters/` defines `IHttpAdapter`/`IFileSystem` interfaces (in `adapters/types.ts`) plus Obsidian implementations; `services/` and `stores/` depend only on the interfaces.
- The `obsidian` package is imported **only** in `src/adapters/obsidian.ts`, `src/main.ts`, `src/settings.ts`, `src/views/`. Keep new Obsidian-API code inside those so services/stores stay pure and unit-testable.
- Tests alias `obsidian` → `tests/mocks/obsidian.ts` via `vitest.config.ts`; shared helpers in `tests/helpers.ts`.
- esbuild config: `external: ["obsidian", "electron"]`, CJS output, target ES2022 (Obsidian requirements — don't switch to ESM output).

## Gotchas

- LLM output is parsed with strict regexes (`N: high|medium|low` scores, bare comma-separated topics). Malformed model output **silently** degrades to "low" — read `src/services/LLMService.ts` and `OLLAMA.md` before touching prompts or parsers.
- Docs: `DEV.md` (dev loop, deploy troubleshooting), `PLAN.md` (design), `OLLAMA.md` (local LLM setup). No README.
