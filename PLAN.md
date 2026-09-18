This is a document for planning an obsidian research panel plugin.

# Architecture & Planning

## Desired Behaviour

The purpose of the plugin is to create a panel to the side of the working document that will surface documents found on the internet that are relevant to the subjects being explored in the working document.

Previews of relevant documents should be given, if an agentic framework is used, the LLM should make a short (One or two concise sentences) summary of the article and why it is relevant to the topics in the working doc and display it under the title of the article. The date it was published should also be displayed in the preview. If the doc is an academic paper the abstract should be displayed in an accordion that expands inline within the result card when it is clicked.

Suggested articles and documents should be able to be pinned or dismissed and should reappear when the panel is opened for the same working document.

Should be able to manually log subjects and topics that can be used to adjust the relevance of documents shown.

Should be able to click to copy a well formed reference (including link) to the clipboard.

Can raise unanswered questions about the working document's content, or underexplored implications that the working doc does not sufficiently address. These should be succinct questions. The user should have the option of opening a chat, and seeing the reasons that the question was posed, and also see relevant documents that are related to both the question and the working doc. The user should be able to dismiss the question. They should be aimed at improving the content in the working doc, and rational truth seeking.

It should be resilient against file name changes. If there is already suggestions and other data from the plugin associated with a particular file, it should still be associated with that same file when it's name is changed.

## Undesired Behaviour

It should not give writing suggestions or make direct edits to the working document.

Note: the plugin stores its own data files inside the vault (see Storage below). This is not a violation — the working document itself is never modified.

## Research Summary

### Existing Plugins & Products (none fully overlap)

| Plugin | Search | Side Panel | Relevance to doc | Q&A | Pinning |
|--------|--------|-----------|------------------|-----|---------|
| **Feynman** | Deep research agent | Chat panel | No auto-relevance | No | No |
| **Research Paper** | Academic DBs | No panel | Manual query only | No | No |
| **Literature Flow** | OpenAlex/Semantic Scholar | Sidebar | Static references | No | No |
| **Sider Copilot** | Web + academic | Side panel | Manual query | Chat | No |
| **Logically** | Google/Scholar | Side panel | Manual query | Chat | No |
| **ResearchMate** | Gemini + Tavily | Chat panel | Context-aware | Chat | No |
| **BibTeX Scholar** | Local only | Side panel | No search | No | Yes |

**Key gap:** No existing plugin auto-discovers documents based on active document content, surfaces relevance summaries with rationales, raises unanswered questions, or persists state per-file with rename resilience.

### Infrastructure Decisions

**LLM / Agentic dependency:** An agentic framework is **not required** for v1. The plugin can:
- Call academic APIs (OpenAlex, Semantic Scholar) directly
- Use direct OpenAI-compatible LLM calls for summarization and topic extraction
- Defer agentic iteration and unanswered questions to later phases

**Web search:** SearXNG is the standard self-hosted meta-search engine. Several Tavily-compatible wrappers exist for agent consumption:
- **OrioSearch** (MIT, Python, Tavily-compatible API, 70+ engines via SearXNG)
- **agent-search** (MIT, MCP-native, SearXNG + Tor)
- **fastCRW** (Rust/AGPL, SearXNG bundled)
- **trawl-search** (MIT, Tavily-wire-compatible, dev-focused)
These are optional upgrades for later phases; v1 uses free academic APIs only.

**Pi vs OpenCode:**
- **Pi** (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`): TypeScript agent toolkit. Good for building a custom embedded agent. Could bundle in-process. But adds significant complexity for v1.
- **OpenCode SDK** (`@opencode-ai/sdk`): Connects to OpenCode Server for agent orchestration. Several existing Obsidian plugins prove this integration works. Adds a runtime dependency (server must be running).
- **Verdict:** Neither is needed for v1. Direct LLM calls + academic API calls cover all v1 features.

# Details

## v1 Implementation Plan

### Scope & Platform Decisions

These are binding constraints for v1, stated explicitly so they shape every design choice below:

| Decision | Detail | Reasoning |
|----------|--------|-----------|
| Markdown-only | Panel activates only for `.md` files. Any other active item (PDF, canvas, image) shows the placeholder state described under Panel States. | The analyzer, topic extraction, and search pipeline assume prose. Supporting other formats multiplies edge cases with no v1 payoff. |
| Desktop-only | Mobile is not a target for v1. | Avoids mobile clipboard quirks, layout constraints, and `@xenova/transformers` memory issues; simplifies testing matrix. |
| English-first | Topic extraction and API queries run on extracted text as-is (English assumed). A language setting is noted as a low-priority future option only. | Both academic APIs index predominantly English works; translation adds cost and failure modes for marginal gain. Easy to add later since it only touches query construction. |
| Singleton view | One panel instance via standard `registerView()` pattern. | Standard Obsidian behavior; no extra work, just documented so it isn't mistaken for a bug. |

### Architecture

```
Obsidian Plugin (TypeScript)
├── ResearchPanelView (ItemView in right sidebar, singleton)
├── DocumentAnalyzer (extract topics from active doc)
├── SearchService (OpenAlex + Semantic Scholar APIs)
├── LLMService (OpenAI-compatible: batched scoring + summarization)
├── ResearchStore (per-document persistence in .research-panel/)
├── CitationFormatter (APA / MLA / Chicago / plain, uses persisted metadata)
└── SettingsTab (LLM endpoint, API keys, model selection)
```

**HTTP layer decision — use Obsidian's `requestUrl()`, not native `fetch`.**
Reasoning: Obsidian ships `requestUrl()` precisely because renderer-context `fetch` is subject to CORS restrictions that `requestUrl()` bypasses entirely (it routes through Electron's main process). Using it:
- Eliminates the entire class of "my LLM provider rejects browser requests" failures
- Makes Anthropic-native endpoints work alongside OpenAI-compatible ones
- Removes any need for proxy configuration in settings
All network calls (academic APIs and LLM endpoints) go through `requestUrl()`. Native `fetch` is not used anywhere.

**Dependency injection constraint.** Services (`SearchService`, `LLMService`, `ResearchStore`, `CitationFormatter`) must not import or call Obsidian APIs directly; instead they receive thin adapter interfaces (HTTP, vault events, filesystem) constructed in `main.ts` and injected.
Reasoning: this is what makes the logic unit-testable outside Obsidian — Vitest can supply fake adapters in milliseconds, while testing against the real Obsidian runtime requires launching Electron and is impractically slow for the rename/index logic that most needs coverage. It costs almost nothing architecturally since the adapters are small and stable.

### Data Flow

1. User opens a markdown document → plugin detects `active-leaf-change`, loads cached results from the document's data file (see Storage); non-markdown items show the placeholder state
2. Panel shows existing results with a **Search / Refresh button** — regeneration is always user-triggered
3. On click: `DocumentAnalyzer` extracts key topics (headings/frontmatter -> LLM refines to 3-5 subjects), rendered as **editable topic chips** above results
4. Chips are the source of truth: `SearchService` queries **OpenAlex** (`/works?search=<topics>`) and **Semantic Scholar** (`/graph/v1/paper/search?query=<topics>`) in parallel using the current chip list
5. Results pass through dedup-by-DOI/title + cap-to-MaxResults **before any LLM call**
6. **One batched LLM call** scores all capped candidates for relevance at once (High/Medium/Low buckets)
7. **Second LLM call(s)** generate 1-2 sentence relevance summaries for top-N results only
8. Results rendered as cards; state persisted per-document; renames handled by `vault.on('rename')`

**Why chips-as-source-of-truth:** the user can correct bad extractions before money is spent on searches/summaries, and re-running a search after editing chips is deterministic — no hidden LLM step between click and query. Topic extraction runs once when the user clicks **Re-extract Topics** (a separate, explicit action next to Search/Refresh), never implicitly during refresh. This separation means refreshing never silently burns LLM tokens on re-extraction, and the user always knows which action triggers which cost.

**Why batching scoring into one call:** scoring N candidates individually costs N round-trips and N× prompt overhead. A single prompt listing all candidates with their abstract snippets returns N bucket ratings in one request — roughly N× cheaper and far faster. Summaries are then generated only for the top slice, so a 20-candidate search might summarize 10.

### Component Details

#### 1. Side Panel (ResearchPanelView)

- Extends `ItemView`, registered via `registerView()` in right sidebar; singleton instance
- Content built with Obsidian DOM API (`contentEl.createEl()`)
- Listens to `workspace.on('active-leaf-change')` to detect active document and load cached state
- Header contains: **Re-extract Topics** button, **Search / Refresh** button
- Scrollable list of result cards

##### Panel States (explicit spec)

Every state the panel can be in is defined here — first-run dead ends were identified as a UX flaw, so each condition has a designed response:

| State | Trigger | Display |
|-------|---------|---------|
| Unconfigured | No LLM endpoint set in settings | Explanation text ("Configure an LLM endpoint in settings to enable research search.") + button that opens the settings tab directly |
| Non-document | Active leaf is not a markdown file | "This is not a working text document." placeholder, no action buttons |
| Loading | Search in progress | Loading skeleton; searches render before LLM steps complete so titles appear early |
| Error | Network/API/LLM failure | Per-source error messages; cached results remain visible where available; never blocks the user |
| Empty | Search succeeded, zero results after dedup/cap | "No relevant documents found" + hint to edit topic chips |
| Ready | Results exist | Card list (ordering below) |

#### 2. Document Topic Extraction

- **Lightweight**: Extract headings, backlinks, tags, frontmatter keywords from `metadataCache`
- **Minimum content guard**: documents below a small content threshold (e.g. <200 words of body text) skip LLM extraction and fall back to headings/tags only — short/sparse notes produce generic LLM topics, which wastes spend and degrades result quality; lightweight signals are more reliable there. The user can always type topics manually regardless.
- **LLM-based**: Send document text to LLM with prompt: *"Extract 3-5 key research topics from this document as a short comma-separated list"*
- Fall back to simple extraction when LLM is unavailable

##### Topic Chips (full CRUD)

Extracted topics render as editable chips above the results:
- **Edit**: inline-edit chip text
- **Remove**: delete a chip
- **Add**: input to append custom topics (this *is* the minimal version of manual topic logging — pulled into v1 because it's cheap to build and closes the feedback loop on bad extractions; the richer deferred version remains below)
- Chips persist in the document's data file (`manualTopics`) so they survive restarts and renames

#### 3. Search: Academic APIs

- **OpenAlex** (250M+ works, free with API key, $1/day credit = ~1000 queries/day; prefer `mailto=` param over key where possible — relevance sort is the default for `search=`, so the sort param is optional)
  - `GET /works?search=<topics>&sort=relevance_score&per_page=10`
  - Returns title, authors, publication date, abstract, citation count, DOI, URL
  - **Note:** abstract is returned as `abstract_inverted_index` (a `word → [positions]` map), NOT a plain string. A reconstruction utility in `SearchService` must rebuild the sentence from the inverted index before display or LLM use.
- **Semantic Scholar** (214M+ papers; **1 req/sec with API key**, unauthenticated requests share a global pool that throttles unpredictably with frequent 429s — exponential backoff required)
  - `GET /graph/v1/paper/search?query=<topics>&limit=10&fields=title,authors,publicationDate,abstract,citationCount,externalIds,url`
- Run both in parallel, deduplicate by DOI/title, interleave results
- **Cap before LLM:** apply an explicit dedup + cap step to enforce `Max Results` across both sources *before* any LLM scoring/summary calls, to bound cost
- Abstract displayed in expandable accordion within each result card
- Open access link surfaced when available: OpenAlex `open_access.oa_url` / `best_oa_location.pdf_url`; Semantic Scholar `openAccessPdf.url`
- All requests via Obsidian `requestUrl()` (CORS-free; see HTTP layer decision)

#### 4. Relevance Scoring & Summarization

Two distinct LLM phases, deliberately separated:

1. **Batched scoring** — one call, all candidates: *"For each numbered candidate below, rate relevance to topics [chips] as High, Medium, or Low..."* Returns one bucket per candidate.
   - Buckets, not numeric scores: numeric ratings imply false precision (an LLM's "7" vs "8" is noise); three buckets communicate triage value honestly.
2. **Summarization** — top-N candidates get 1-2 sentence relevance summaries (second call or small batch).

Embedding-based scoring (`@xenova/transformers`, cosine similarity) is **out of v1 entirely** — see Deferred.

- Cache summaries per-URL to avoid redundant LLM calls across refreshes
- Configurable model and endpoint in settings

##### Card Design & Ordering

Ordering rule (fixed): **pinned first → then by relevance bucket (High > Medium > Low) → then publication recency.**

Each card contains: title, authors, publisher/venue, publication date, relevance summary (when generated), relevance bucket badge, snippet, inline abstract accordion, OA PDF link (when available), and actions: Pin, Dismiss, Copy Reference, Open URL. All icon-only buttons have tooltips.

#### 5. Pin / Dismiss / Undismiss & Refresh Semantics

- Pinned cards sort to top and survive refreshes indefinitely
- Dismissed items collapse into a **"Dismissed (n)" section** at the bottom of the list, each with an **Undismiss** action
- Dismissals are **strictly per-document** — dismissing a URL in one note has no effect in another note

**Refresh semantics (explicit, previously implicit):**
- Refresh **merges**: new results are added to the existing record; pinned URLs always survive and are excluded from duplicate insertion
- Dismissed URLs stay filtered out of the main list until undismissed — even if they reappear in fresh results
- No destructive reset anywhere in the UI; the only way to lose pinned/dismissed state is deleting the note (and even that retains the data file, see Storage)

Reasoning: accidental dismissal was flagged as an unrecoverable dead end in review; the Dismissed section plus Undismiss makes every state reversible, and merge-on-refresh guarantees user curation is never discarded by a re-search.

#### 6. Copy Reference

- Formats supported: APA, MLA, Chicago, plain URL
- The card's copy button opens a **format menu on click** rather than relying solely on the global default — copying in multiple styles is a common workflow and settings-diving per copy is friction
- Settings retain a default-format preference for one-click copies
- Field mapping for publisher/venue: OpenAlex → `primary_location.source.display_name`; Semantic Scholar → `venue`. Omitted gracefully from the citation string when absent.
- Clipboard via `navigator.clipboard.writeText()` with `document.execCommand('copy')` fallback; desktop-only target keeps this simple
- Uses persisted `authors`/`publisher`/`year` — a free-form `date` string alone is insufficient for reliable year extraction (see Storage schema)

#### 7. Storage

**Decision: per-document storage in a plugin-owned dot-folder, keyed by stable IDs — not a single global `data.json`.**

Reasoning: the original single-`data.json` design rewrites and re-serializes *every* document's state on any change, and grows unboundedly with abstracts and suggestions. Per-document files make writes atomic at document granularity, keep individual files small, play well with file-level sync (Syncthing resolves conflicts per-file without cross-document corruption), and make rename resilience nearly free (see below).

```
.research-panel/
├── index.json          # { "<note-path>": "<data-file-id>", ... }
└── <data-file-id>.json # one per document
```

- Folder name starts with a dot → **hidden from Obsidian's file explorer** by default; users don't see clutter
- **Sync caveat, documented:** dot-folders are skipped by Obsidian Sync/iCloud/Dropbox. Syncthing syncs dotfiles by default, which suits the primary use case; users on other sync solutions keep research state device-local unless they configure otherwise. Accepted trade-off vs. visible sidecars next to notes (rejected: clutters every folder).
- Global plugin settings remain in standard `data.json` (settings don't need rename resilience)

##### Data File Schema

```json
{
  "id": "<uuid>",
  "notePath": "<path at last write>",
  "noteTitle": "<fallback lookup key>",
  "manualTopics": ["chip", "chip"],
  "pinned": ["url1", "url2"],
  "dismissed": ["url3"],
  "suggestions": [
    {
      "url": "...",
      "title": "...",
      "authors": ["..."],
      "publisher": "...",
      "year": 2024,
      "bucket": "high",
      "summary": "...",
      "date": "...",
      "abstract": "...",
      "oaUrl": "..."
    }
  ]
}
```

(`pinned` flag on suggestions removed — pin/dismiss state lives in the top-level arrays, single source of truth.)

##### Rename Resilience (files AND folders)

The core trick: **data files are named by random UUID, never by path.** Only `index.json` maps path → ID. Renames therefore touch one small index entry instead of requiring a file rename that could race with sync or fail mid-write.

Handling `vault.on('rename', (file, oldPath))`:
- **TFile renamed/moved:** update `index.json[oldPath] → newPath`
- **TFolder renamed/moved:** Obsidian fires one event with the folder object; rewrite every index entry whose key starts with the old folder prefix. This covers nested documents wholesale.
- **`vault.on('delete')`:** remove the index entry but **retain the data file, marked orphaned** — accidental deletions stay recoverable; garbage collection can come later

Safety nets:
- **Index-miss fallback:** fuzzy lookup by note basename/title before concluding "no cached results"
- **Self-heal:** every data file carries its own `notePath`; if `index.json` is lost or corrupted (sync conflict), rebuild it by scanning data files
- **Atomic writes:** write temp file + rename, so a crash or sync race never yields half-written state

#### 8. Settings

| Setting | Description |
|---------|-------------|
| LLM Endpoint URL | Any OpenAI-compatible API endpoint (or Anthropic-native — `requestUrl()` bypasses CORS so no provider restrictions) |
| LLM API Key | Authentication for LLM provider |
| LLM Model | Model name (e.g., gpt-4o-mini, claude-3-haiku, llama3.2) |
| OpenAlex API Key | Optional, increases rate limits |
| Semantic Scholar API Key | Optional but recommended — 1 req/sec authenticated vs unpredictable unauthenticated throttling |
| Default Citation Format | APA / MLA / Chicago / Plain (per-copy menu overrides this per use) |
| Max Results | Number of suggestions per document |

### Risk Mitigations

| Risk | Mitigation |
|------|------------|
| LLM latency (3-10s per call) | Loading skeleton; searches render before LLM steps; batched scoring = 2 calls total regardless of candidate count; cache summaries per-URL |
| Rate limiting (429 responses) | Exponential backoff (required by Semantic Scholar); user-configurable API keys for both sources |
| LLM cost | Cap before any LLM call; batched scoring; summarize top-N only; cache per-document; regeneration only on explicit user action; cheap-model support |
| Privacy | Document text sent to LLM provider; doc titles/topics sent to academic APIs. Mitigation: local Ollama endpoint works fine over `requestUrl`; privacy documented in README |
| No network / API down | Cached results with offline indicator; per-source error messages; never blocks the user |
| Storage bloat | Per-document files stay small and isolated; orphaned files marked rather than accumulated invisibly; GC deferred but structurally easy |
| External file changes bypass rename event | Index-miss fuzzy fallback by note title; self-healing index rebuild from data files' embedded paths |
| Sync conflicts (Syncthing etc.) | Atomic per-file writes; UUID-named data files mean conflicts corrupt at worst one document, never the index of others; index is rebuildable |

*(CORS removed as a risk class — `requestUrl()` bypasses it entirely.)*

### Caching Strategy

- **Per-document results**: persisted in `.research-panel/<id>.json`; survive app restarts and doc switches
- **Regeneration**: only on explicit user action (Search / Refresh button click) — never automatic; Re-extract Topics is likewise explicit and separate
- **Summary cache**: LLM summaries cached per URL to avoid regenerating summaries for the same URL across refreshes
- **Invalidation**: user click merges fresh results; no automatic invalidation

### Testing Plan

**Decision: local tests only (`npm test` via Vitest) — no CI.**
Reasoning: this is a single-developer plugin; a CI pipeline adds maintenance surface without matching the actual risk profile. The risk concentrates in *pure stateful logic* (rename resilience, index self-heal, merge semantics, citation formatting), which is exactly what unit tests cover cheaply and deterministically. Live-API behavior varies too much to assert on in automation and belongs in a manual checklist.

#### 1. Unit Tests (Vitest) — primary coverage

Pure-logic tests running in Node with fake adapters (see dependency injection constraint above). These target the areas where silent breakage would corrupt user data or waste LLM spend:

| Area | Cases |
|------|-------|
| Abstract reconstruction | OpenAlex `abstract_inverted_index` → readable string; edge cases: missing/empty index, words at multiple positions, single-word abstracts |
| Dedup + cap | DOI/title dedup across interleaved sources (case/whitespace variance in titles); cap strictly enforced **before** any LLM call |
| Batched scoring | Prompt construction from chips + candidates; bucket parsing from messy LLM output — mixed case, extra prose around answers, invalid values defaulting to Low |
| CitationFormatter | All 4 formats × complete metadata × partial (missing publisher/year/authors) × empty; graceful segment omission |
| ResearchStore rename logic | File rename → index entry updated; folder rename → prefix rewrite of all nested entries; delete → index entry removed but data file retained + orphan-marked |
| Index self-heal | Corrupted/truncated `index.json` → rebuild from embedded `notePath` fields; index-miss fuzzy title fallback ordering |
| Merge-on-refresh | Pins survive; dismissed URLs stay filtered even when re-fetched; no duplicate insertion; new results appended with fresh buckets |

ResearchStore tests get the most cases because it's the highest-consequence component: a bug there silently loses curated pin/dismiss state, which is unrecoverable from anywhere else.

#### 2. Integration Tests (mocked Obsidian API)

A minimal fake of `Plugin`, `Vault`, `Workspace` covering:
- Panel state machine transitions: unconfigured → ready; markdown → non-md placeholder on active-leaf change; error fallbacks leaving cached results visible
- Persistence round-trip: save → load fidelity, plus atomic-write behavior (temp file written before rename; crash between steps leaves previous state intact)

These run in-process against fakes, so they're still fast enough for every-save execution.

#### 3. Manual Smoke Checklist (documented in repo, run before releases)

Automated tests can't meaningfully assert on live third-party behavior, so real-network verification stays manual:

- [ ] OpenAlex/Semantic Scholar searches with and without API keys (exercises 429/backoff path unauthenticated)
- [ ] Rename/move/delete notes and folders in a real test vault; verify pinned/dismissed state follows
- [ ] Syncthing syncing during edits; verify no index corruption after conflict resolution
- [ ] LLM endpoint swap: OpenAI-compatible cloud endpoint, local Ollama, and a deliberately malformed response (verify graceful degradation)
- [ ] Copy-reference menu across all four formats pasted into a note
- [ ] First-run experience on a fresh vault (unconfigured state → settings → ready)

#### Tooling Notes

- Vitest chosen over Jest: TS-native config, faster startup, better ESM support with zero extra tooling
- Test dependencies stay in `devDependencies`; esbuild plugin bundle never includes them
- Single entry point: `npm test`


### Key Dependencies (npm)

| Package | Purpose |
|---------|---------|
| `obsidian` | Plugin API (built-in), including `requestUrl` |

No HTTP client needed (`requestUrl`). No embeddings dependency in v1.

### File Structure

```
obsidian-research-panel/
├── manifest.json
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── styles.css
├── DEV.md                       # WSL→Windows dev loop, deploy setup, BRAT distribution
├── scripts/
│   └── deploy.mjs               # Copies dist/ into configured vault + .hotreload marker
├── src/
│   ├── main.ts                 # Plugin entry, register view, settings
│   ├── views/
│   │   ├── ResearchPanelView.ts # ItemView, panel states, topic chips, card list
│   │   └── panelState.ts        # Pure panel-state derivation (unit tested)
│   ├── services/
│   │   ├── DocumentAnalyzer.ts  # Topic extraction (lightweight + LLM, content-length guard)
│   │   ├── SearchService.ts     # OpenAlex + Semantic Scholar via requestUrl, inverted-index reconstruction, dedup/cap
│   │   ├── LLMService.ts        # Batched relevance scoring + summarization
│   │   └── CitationFormatter.ts # APA/MLA/Chicago/plain (uses persisted authors/publisher/year)
│   ├── stores/
│   │   └── ResearchStore.ts     # .research-panel/ storage, index management, rename/delete handlers, self-heal
│   ├── adapters/
│   │   ├── types.ts             # IHttpAdapter / IFileSystem interfaces (DI seams)
│   │   └── obsidian.ts          # requestUrl + vault-adapter implementations
│   ├── types.ts                 # Shared type definitions
│   └── settings.ts              # Plugin settings tab
├── tests/
│   ├── helpers.ts               # FakeFs / FakeHttp / sleep recorder
│   ├── unit/                    # Store, search, LLM, citation, analyzer suites
│   └── integration/             # Panel-state transitions
└── dist/                        # Dev build output (gitignored); production bundles at repo root
```

**Dev workflow note:** `npm run dev` watches sources in WSL ext4 and auto-deploys each rebuild to the vault path configured in gitignored `.vault-path.local` (env var `OBSIDIAN_VAULT` overrides). The Windows-side Hot-Reload plugin then reloads the plugin automatically — see DEV.md. Production builds stay at the repo root and never touch any vault.

### v1 Feature Summary

| Feature | Status |
|---------|--------|
| Right sidebar ItemView (singleton) | ✅ v1 |
| Explicit panel states (unconfigured / loading / error / empty / non-md) | ✅ v1 |
| Topic extraction + editable/addable/removable topic chips | ✅ v1 |
| Separate explicit Re-extract Topics action | ✅ v1 |
| OpenAlex + Semantic Scholar search | ✅ v1 |
| Batched relevance scoring with High/Medium/Low buckets | ✅ v1 |
| LLM relevance summaries (top-N only) | ✅ v1 |
| Abstract accordion on result cards | ✅ v1 |
| Open-access PDF links | ✅ v1 |
| Pin/dismiss/undismiss + Dismissed section | ✅ v1 |
| Merge-on-refresh semantics | ✅ v1 |
| Per-document persistence (.research-panel/, UUID-keyed) | ✅ v1 |
| Rename resilience (files + folders) with self-heal | ✅ v1 |
| Copy reference with per-click format menu | ✅ v1 |
| Configurable LLM provider (no CORS restrictions via requestUrl) | ✅ v1 |
| In-panel document viewer | ❌ Deferred (requires PDF.js, not iframe) |

### Deferred to Later Phases

- Unanswered questions about document gaps
- In-panel document viewer — **explicitly out of v1** despite being a Desired Behaviour. Note: plain `<iframe>` cannot reliably render external PDFs in Obsidian's Electron (framing/CORS restrictions); implementing this requires a PDF.js-based viewer fed by `best_oa_location.pdf_url` / `open_access.oa_url`, which is non-trivial and scoped for a later phase.
- Self-hosted web search via SearXNG/OrioSearch
- Full manual topic logging UI beyond v1's topic chips (schema already supports it)
- Agentic search iteration (OpenCode SDK or Pi integration)
- Embedding-based relevance scoring via `@xenova/transformers` — deferred past v1 entirely; batched LLM scoring covers the need without a ~100MB+ runtime dependency
- Language/locale setting for non-English workflows (low priority; touches only query construction)
- Garbage collection of orphaned data files (retained-and-marked until then)
