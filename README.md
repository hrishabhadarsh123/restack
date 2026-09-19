# restack

[![CI](https://github.com/hrishabhadarsh123/restack/actions/workflows/ci.yml/badge.svg)](https://github.com/hrishabhadarsh123/restack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/restack-ai)](https://www.npmjs.com/package/restack-ai)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Legacy → modern stack converter, powered by Claude's 200k context window.**

📖 **Docs site:** [hrishabhadarsh123.github.io/restack](https://hrishabhadarsh123.github.io/restack/) — overview, architecture deep-dive & a full [PHP→Next.js walkthrough](https://hrishabhadarsh123.github.io/restack/walkthrough).

Point `restack` at an old project — a PHP/jQuery app or a Python 2 codebase — and it reads the
whole folder, understands the structure and dependencies in a single planning call, then converts
it file-by-file into an idiomatic modern codebase:

| Legacy stack | Modern target |
|---|---|
| PHP / jQuery / PDO / mysql_* | **Next.js 15 (App Router) + TypeScript strict** |
| Python 2 (print statements, old syntax) | **FastAPI + Pydantic v2 + SQLAlchemy 2.0** |

Your original project is never modified — all output goes to a separate folder.

## Install / build

Use without installing (after publishing, `npx restack-ai ...` works directly):

```bash
# from source
git clone https://github.com/hrishabhadarsh123/restack.git
cd restack
npm install
npm run build          # dist/cli.js
npm test               # vitest (unit + e2e with mocked Claude — no API key needed)
npm run typecheck
node dist/cli.js --help
```

> Replace `hrishabhadarsh123` with your GitHub handle after forking/cloning — it appears in badges,
> clone URLs and package metadata.

## Quick start

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# 1. Dry analysis — no API key needed
restack scan ./legacy-app
#   Stack: php-jquery (confidence 82%)
#   estimated tokens  48.3k          → fits in one 200k window

# 2. Plan only (one big Claude call)
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

### `restack plan <root> [--target t]`

Packs as many files as fit into one Claude call — entry/config/routes/shared first, oversized
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
  bounded repair round feeds compiler errors back to Claude.
- **Checkpoint/resume**: progress is persisted to `.restack/state.json` after every batch;
  `--resume` skips already-converted sources and reuses the saved plan.
- **Cost guard**: `--max-cost` (default $20) aborts before a call that would exceed the budget.
  Exponential backoff on 429/5xx.

```bash
restack convert ./legacy-app --target fastapi --out ./converted \
  --model claude-sonnet-4-5 --workers 3 --max-cost 15 --review
```

`--dry-run` shows the plan and exits without converting. `--review` adds a final cross-file
consistency pass.

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
| `ANTHROPIC_API_KEY` | required for `plan` / `convert` |
| `ANTHROPIC_AUTH_TOKEN` | optional Bearer token (gateway/proxy environments) |
| `ANTHROPIC_BASE_URL` | optional API base URL override (picked up by the SDK) |

Models: `claude-sonnet-4-5` (default), `claude-opus-4-1`, `claude-haiku-4-5` — see
`src/util/tokens.ts` for the pricing table used by cost estimates.

## Layout

```
src/
  cli.ts            scan | plan | convert commands
  scanner.ts        walk + stack detection + roles + token estimate
  packer.ts         context budget manager (verbatim vs summarized vs omitted)
  planner.ts        pass 1: structured MigrationPlan (zod-validated)
  converter.ts      batching + prompt building + <file> output parser
  converter-core.ts pass 2: waves, verify/repair loop, scaffold writing
  review.ts         pass 3 (optional): cross-file consistency fixes
  state.ts          checkpoint/resume + plan persistence + CostLimitError
  anthropic.ts      SDK wrapper: retries, caching, usage/cost accounting
  profiles/         nextjs + fastapi: conventions, scaffold, verification
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
