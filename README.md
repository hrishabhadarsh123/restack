# restack

[![CI](https://github.com/hrishabhadarsh123/restack/actions/workflows/ci.yml/badge.svg)](https://github.com/hrishabhadarsh123/restack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/restack-ai)](https://www.npmjs.com/package/restack-ai)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Legacy → modern stack converter, powered by any frontier model's 200k+ context window.**

📖 **Docs site:** [hrishabhadarsh123.github.io/restack](https://hrishabhadarsh123.github.io/restack/) — overview, architecture deep-dive & a full [PHP→Next.js walkthrough](https://hrishabhadarsh123.github.io/restack/walkthrough).

Point `restack` at an old project — a PHP/jQuery app or a Python 2 codebase — and it reads the
whole folder, understands the structure and dependencies in a single planning call, then converts
it file-by-file into an idiomatic modern codebase:

| Legacy stack | Modern target |
|---|---|
| PHP / jQuery / PDO / mysql_* | **Next.js 15 (App Router) + TypeScript strict** |
| Python 2 (print statements, old syntax) | **FastAPI + Pydantic v2 + SQLAlchemy 2.0** |
| Django (models, urls, views, forms) | **FastAPI + Pydantic v2 + SQLAlchemy 2.0** |

Your original project is never modified — all output goes to a separate folder.

Works with every major model provider — set one key (auto-detected) or force with `--provider`:

| Provider | Env var | Default model |
|---|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| OpenAI (GPT) | `OPENAI_API_KEY` | `gpt-5.2` |
| OpenRouter / OpenAI-compatible | `OPENROUTER_API_KEY` (+ `OPENROUTER_BASE_URL`) | pass `--model` |
| Google (Gemini) | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-3-pro` |

## Install / build

Use without installing (after publishing, `npx restack-ai ...` works directly):

```bash
# from source
git clone https://github.com/hrishabhadarsh123/restack.git
cd restack
npm install
npm run build          # dist/cli.js
npm test               # vitest (unit + e2e with mocked model clients — no API key needed)
npm run typecheck
node dist/cli.js --help
```

> Replace `hrishabhadarsh123` with your GitHub handle after forking/cloning — it appears in badges,
> clone URLs and package metadata.

## Quick start

```bash
# pick ONE provider key — auto-detected, or force with --provider
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY

# 1. Dry analysis — no API key needed
restack scan ./legacy-app
#   Stack: php-jquery (confidence 82%)
#   estimated tokens  48.3k          → fits in one 200k window

# 2. Plan only (one big planning call)
restack plan ./legacy-app --target nextjs

# 3. Full conversion
restack convert ./legacy-app --target nextjs --out ./converted
```

If `--target` is omitted, restack picks it from the detected stack
(`php-jquery → nextjs`, `python2 → fastapi`).

## Commands

### `restack scan <root>`

Walks the project (skipping `node_modules`, `.git`, `vendor`, `__pycache__`, …), detects the stack
from structural and content markers (composer.json, py2 print statements, xrange, jQuery usage,
except-syntax, coding cookies…), classifies file roles (entry/route/shared/config/…), estimates
tokens, and warns about sensitive files (`.env`, keys, credentials) which are **never** read into
context.

Add `--json` for machine-readable output — stack, confidence, per-file roles and token counts and
excluded sensitive files go to **stdout** while human-readable logs stay on **stderr**, so it pipes
cleanly into `jq` or CI checks (file contents are never included):

```bash
restack scan ./legacy-app --json | jq '{stack, confidence, totalTokens}'
```

`plan --json` emits a schema-versioned report (stack, target, plan hash, file mappings, waves,
risks, cost) on stdout; `convert --json` streams newline-delimited JSON events (`run`, `wave`,
`batch_start`, `batch_complete`, `file`, `summary`) so scripts can follow a conversion live. Same
stream discipline everywhere: JSON on stdout, human logs on stderr.

### `restack plan <root> [--target t]`

Packs as many files as fit into one planning call — entry/config/routes/shared first, oversized
files summarized head+tail — and returns a structured **MigrationPlan**:

- architecture decisions for *this* project
- file-by-file mapping (`pages/users.php` → `app/users/page.tsx`)
- URL route table (`index.php?page=users` → `/users`)
- dependency wave order (the conversion DAG)
- risks

Saved to `<outDir>/.restack/plan.json`.

### `restack convert <root> [--target t] [--out dir]`

Runs plan → conversion → (optional) review:

- **Waves & batches**: sources are converted in the plan's dependency waves; independent batches
  run with bounded concurrency (`--workers`, default 2).
- **Strict output format**: the model must emit `<file path="...">…</file>` blocks; a tolerant
  parser extracts them and refuses path traversal.
- **Verify + repair**: each batch is verified — `tsc --noEmit` for Next.js output (bracket-balance
  fallback when no compiler is available), `ast.parse` + import smoke test for Python — and a
  bounded repair round feeds compiler errors back to the model.
- **Checkpoint/resume**: progress is persisted to `.restack/state.json` after every batch;
  `--resume` skips already-converted sources and reuses the saved plan.
- **Cost guard**: `--max-cost` (default $20) aborts before a call that would exceed the budget.
  Exponential backoff on 429/5xx.

```bash
restack convert ./legacy-app --target fastapi --out ./converted \
  --provider openai --model gpt-5.2 --workers 3 --max-cost 15 --review
```

`--dry-run` shows the plan and exits without converting. `--review` adds a final cross-file
consistency pass.

## Use inside AI agents (MCP)

restack ships a built-in [Model Context Protocol](https://modelcontextprotocol.io) server, so agent
platforms — **Google Antigravity, Hermes Agent, Claude Code, Cursor, Windsurf, ...** — can drive
the whole pipeline as tools instead of shelling out to the CLI:

```bash
restack mcp          # stdio transport (the standard for local agent tools)
```

| Tool | What it does |
|---|---|
| `restack_scan` | stack detection + file inventory + token estimate (no API key needed) |
| `restack_plan` | structured migration plan (dry run) |
| `restack_convert` | full conversion into `<outDir>` (verify + repair, resume support) |
| `restack_status` | inspect a previous run: statuses, spend, what would resume |

Example `mcpServers` config (Antigravity / Claude Code / Cursor / Hermes all use this shape):

```json
{
  "mcpServers": {
    "restack": {
      "command": "npx",
      "args": ["-y", "restack-ai", "mcp"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

Every tool returns an agent-facing summary plus a machine-readable `_restack` JSON block, so the
agent can chain `scan → plan → convert → status` and react to real data (costs, waves, failures)
instead of parsing prose.

### SDK — embed restack in your own tooling

```ts
import { scanProject, runPlanner, runConverter, selectProvider, createClient } from "restack-ai";

const scan = await scanProject("./legacy-app");
const client = createClient(selectProvider("openai"), "gpt-5.2");
const { plan } = await runPlanner(client, scan, { target: "nextjs", model: "gpt-5.2" });
await runConverter(client, scan, plan, "./converted", { target: "nextjs", model: "gpt-5.2", workers: 2 });
```

## How the 200k window is used

```
Planning call:  [conventions + plan instructions] + [project pack ≤ ~180k tokens]
                └─ inventory of EVERY file + verbatim source of as many as fit
                   (entry/config first; big files → head+tail summary)

Convert call:   [system: conventions + plan tables] + [≤3 sources per batch]
                └─ <file> blocks out; verify (tsc / ast) → repair loop
```

Prompt caching marks the conversion system prompt as cacheable, so repeated batches pay
cache-read prices (~10% of input) for the stable plan context.

## Configuration

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude key (highest detection priority) |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | OpenAI, or any OpenAI-compatible gateway |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google Gemini |
| `OPENAI_BASE_URL` | endpoint override for OpenAI-compatible APIs (OpenRouter, Groq, Together, Ollama, …) |
| `ANTHROPIC_AUTH_TOKEN` | optional Bearer token (gateway/proxy environments) |
| `ANTHROPIC_BASE_URL` | optional Anthropic base URL override (picked up by the SDK) |

Defaults: `claude-sonnet-4-5`, `gpt-5.2`, `gemini-3-pro` — override with `--model` (a model from
another provider's family triggers a warning). Pricing per model lives in `src/util/tokens.ts` and
drives both cost estimates and the packer's context budget (gpt-5.x: 400k window, Gemini: 1M).

## Layout

```
src/
  cli.ts            scan | plan | convert | mcp commands
  scanner.ts        walk + stack detection + roles + token estimate
  packer.ts         context budget manager (verbatim vs summarized vs omitted)
  planner.ts        pass 1: structured MigrationPlan (zod-validated)
  converter.ts      batching + prompt building + <file> output parser
  converter-core.ts pass 2: waves, verify/repair loop, scaffold writing
  review.ts         pass 3 (optional): cross-file consistency fixes
  state.ts          checkpoint/resume + plan persistence + CostLimitError
  providers/        anthropic | openai | gemini clients + env detection + factory
  profiles/         nextjs + fastapi: conventions, scaffold, verification
  mcp.ts            MCP server: pipeline as agent tools over stdio
  index.ts          SDK entry for embedding restack programmatically
test/
  fixtures/         mini PHP/jQuery + Python 2 apps
  *.test.ts         scanner / packer / planner / converter unit + e2e tests
```

## Notes & limits

- Cost estimates use a ~3.8 chars/token heuristic and the pricing table in
  `src/util/tokens.ts`; treat them as estimates.
- Verification runs `tsc` only if a TypeScript compiler is available (local
  `node_modules/.bin` in the output dir or on PATH); otherwise it falls back to a
  bracket-balance sanity check.
- The Python import smoke test only runs when `fastapi`/`pydantic` are importable in the
  ambient interpreter (e.g. after `pip install -r requirements.txt`).
- Repositories larger than one window still work: the packer summarizes oversized files and
  omits the rest (they remain visible in the inventory so the plan still references them).
