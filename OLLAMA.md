# Ollama Quickstart (local LLM)

How to serve a local model with [Ollama](https://ollama.com) on **Windows** and point the Research Panel at it. Written for a GTX 1070 (8 GB VRAM) but any CUDA GPU works the same way.

The plugin talks to one OpenAI-compatible chat completions endpoint and uses **a single model for every task** (topic extraction, relevance scoring, summaries) — see `src/services/LLMService.ts`. You pick one model from the table below and put its name in the plugin settings. No API key is needed for local servers; Obsidian's `requestUrl` bypasses CORS, so no extra Ollama config is required either.

## 1. Install Ollama

Download and run the [Windows installer](https://ollama.com/download/windows). It installs a tray app that serves `http://localhost:11434` automatically at login.

Verify the GPU is visible:

```powershell
nvidia-smi          # driver sees the 1070
ollama --version    # CLI installed
```

## 2. Pick and pull a model

All three plugin tasks are simple *structured* prompts, so instruction-following quality matters more than raw knowledge. Start small; upgrade only if output quality disappoints.

| Tier | Model | Download | Why pick it |
|------|-------|----------|-------------|
| Fast default | `ollama pull llama3.2:3b` | ~2 GB | Snappiest; big context headroom |
| Balanced | `ollama pull gemma3:4b` | ~3 GB | Quality step up, still fast |
| **Max quality (recommended)** | `ollama pull qwen2.5:7b` | ~4.7 GB | Best strict-format adherence → most reliable scoring |
| Alt max quality | `ollama pull llama3.1:8b` | ~4.9 GB | General-purpose alternative |

Notes:

- **Why Qwen tops the table:** scoring parses model output with a strict regex (`N: high|medium|low`) and topic extraction expects a bare comma-separated list. Models that drift into prose break parsing silently — every candidate just falls back to "low". If you ever see malformed scores/topics, switch to `qwen2.5:7b`.
- Avoid small `qwen3:*` variants here: their thinking mode can emit `<think>…</think>` blocks that pollute parsed lists.
- **GTX 1070 expectations:** Pascal has no tensor cores and modest memory bandwidth, so ignore RTX-class benchmark numbers. Rough order of magnitude: 40–60 tok/s for the 3B, 20–30 tok/s for the 7B at Q4. Fine for this plugin's batch-style calls.

## 3. Raise the context window (do not skip)

Ollama defaults to **4096 tokens** on GPUs with < 24 GiB VRAM. The batch-scoring prompt sends up to 30 candidates × ~600-char abstracts plus instructions — that can exceed 4K tokens, and a truncated prompt means truncated/garbled scoring. Set an 8K window before judging model quality.

1. Quit Ollama from the system tray (right-click → Quit).
2. Open **Settings → System → Edit environment variables for your account** (Win10: Control Panel → environment variables).
3. Create/edit these **user variables**:

   | Variable | Value |
   |----------|-------|
   | `OLLAMA_CONTEXT_LENGTH` | `8192` |
   | `OLLAMA_KEEP_ALIVE` | `1h` |

4. Relaunch Ollama from the Start menu.

`OLLAMA_KEEP_ALIVE` stops the model unloading between panel refreshes (default is only 5 minutes, so the first call after idle pays a reload pause).

Per-model alternative instead of the env var: a `Modelfile` with `PARAMETER num_ctx 8192` (see `ollama create --help`). The env var is simpler and covers every model.

## 4. Confirm it runs on the GPU

```powershell
ollama run qwen2.5:7b "Say OK"
# exit the chat, then:
ollama ps
```

The `PROCESSOR` column should read `100% GPU`. If it says `CPU` or a split, update your NVIDIA driver and recheck `nvidia-smi` first.

## 5. Point the plugin at Ollama

In Obsidian: **Settings → Research Panel**:

| Setting | Value |
|---------|-------|
| Endpoint URL | `http://localhost:11434/v1` |
| API key | *(leave empty)* |
| Model | exactly what `ollama list` prints, e.g. `qwen2.5:7b` |

Then trigger a panel refresh.

## 6. Smoke test without Obsidian

PowerShell:

```powershell
Invoke-RestMethod -Uri http://localhost:11434/v1/chat/completions `
  -Method Post -ContentType "application/json" `
  -Body (@{ model = "qwen2.5:7b"; messages = @(@{ role = "user"; content = "Reply with only: OK" }) } | ConvertTo-Json -Depth 5)
```

You should get back a JSON completion containing `OK`.

## Pulling from Hugging Face instead

Any community GGUF also runs directly, no Modelfile needed:

```powershell
ollama run hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
```

Syntax: `hf.co/{user}/{repo}:{QUANT}` (quant tag optional; defaults to the repo's recommended file). Useful when you want a specific quant or a model the Ollama library doesn't carry.

Caveat: some HF repos have broken manifests — the multi-GB download finishes, then fails with `Error: 400` and the model never appears in `ollama list`. This is an upstream bug, not your setup. If it happens, just use the equivalent registry model (`ollama pull …`); registry pulls are unaffected.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ollama ps` shows CPU / split | Update the NVIDIA driver; confirm `nvidia-smi` lists the 1070 |
| Scores all "low", topics garbled, replies cut off | Context truncation — did step 3 take effect? Fully quit the tray app and relaunch from the Start menu |
| Malformed scores/topics even mid-range | Switch the plugin model to `qwen2.5:7b` |
| First response slow after sitting idle | Model was unloaded — set `OLLAMA_KEEP_ALIVE=1h` (step 3) |
| Out-of-memory / model won't load fully | Close GPU-heavy apps (games, hardware-accelerated browsers eat 0.5–1.5 GB of the 8 GB); drop a size class (7B → 4B) |
| Plugin errors, connection refused | Is the tray icon running? Endpoint must end in `/v1`; model name must match `ollama list` exactly |
| HF pull dies with `Error: 400` | Known HF manifest bug (see above) — use the registry equivalent |

---

Dev loop and vault deployment live in [DEV.md](DEV.md); project roadmap in [PLAN.md](PLAN.md).
