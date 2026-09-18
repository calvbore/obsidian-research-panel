# Research Panel

An [Obsidian](https://obsidian.md) plugin that surfaces relevant academic documents for the note you're working on. Open a markdown file, hit search, and the panel queries [OpenAlex](https://openalex.org) and [Semantic Scholar](https://www.semanticscholar.org), then uses a local or remote LLM to score results for relevance and write short summaries — so you find sources without leaving your note.

## Features

- **Automatic topic extraction** from the active note, rendered as editable topic chips you can correct before anything is searched.
- **Dual academic search** — OpenAlex and Semantic Scholar queried in parallel, deduplicated by DOI/title.
- **LLM relevance scoring** — all candidates bucketed high/medium/low in a single batched call; 1–2 sentence relevance summaries for the top results.
- **Pin & dismiss** — decisions persist per document and survive renames, folder moves, and restarts.
- **One-click citations** — copy a well-formed reference (APA, MLA, Chicago, or plain) with link.
- **Per-document state** stored inside your vault in `.research-panel/`; your notes themselves are never modified.

Search/refresh is always user-triggered; the panel never edits your notes or burns tokens implicitly.

## Requirements

- Obsidian desktop (v1.5.0+); mobile is not supported.
- Markdown notes only — the panel shows a placeholder for other item types.
- An LLM endpoint for topic extraction, scoring, and summaries. Anything OpenAI-compatible or Anthropic-format works, including a free local [Ollama](https://ollama.com) server — see [OLLAMA.md](OLLAMA.md) for a local setup guide. No API key is needed for local servers.
- Optional: an OpenAlex [polite-pool email](https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication) and a Semantic Scholar API key (both free, both improve rate limits).

## Installation

**Via [BRAT](https://github.com/TfThacker/obsidian42-brat)** (recommended while this plugin is in beta):

1. Install and enable BRAT.
2. Run `BRAT: Add Beta Plugin` and enter `calvbore/obsidian-research-panel`.

**Manual:** download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/calvbore/obsidian-research-panel/releases) into `<vault>/.obsidian/plugins/research-panel/`, then enable the plugin in Obsidian's community-plugins settings.

## Usage

1. Open a markdown note and click the graduation-cap ribbon icon (or run **Open research panel** from the command palette).
2. Review the extracted topic chips — edit or remove them freely; chips drive the search.
3. Hit **Search**. Results appear as cards grouped by relevance bucket, with abstracts expandable inline.
4. Pin what matters, dismiss the rest. Reopening the panel for that note restores its state.
5. Click a card's citation action to copy a reference in your preferred format (configurable in settings).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit over src/ + tests/
npm test            # Vitest, no Obsidian instance required
npm run build       # typecheck + minified release bundle to root main.js
```

`npm run dev` watches `src/` and auto-deploys each build into a test vault — the dev loop is designed for WSL against a Windows-side Obsidian vault. See [DEV.md](DEV.md) for the full setup and [AGENTS.md](AGENTS.md) for repository conventions. Design notes live in [PLAN.md](PLAN.md).

## License

[MIT](LICENSE)
