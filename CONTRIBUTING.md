# Contributing to restack

Thanks for helping make legacy-to-modern migrations easier! This guide covers the basics.

## Development setup

```bash
git clone https://github.com/hrishabhadarsh123/restack.git
cd restack
npm install
```

Useful scripts:

| Script | What it does |
|---|---|
| `npm run dev` | tsup watch build |
| `npm run build` | build `dist/cli.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest (unit + e2e, mocked Claude — no API key needed) |
| `npm run restack -- scan ...` | run the local build |

## Project layout

```
src/
  cli.ts            command wiring (scan | plan | convert)
  scanner.ts        stack detection, roles, token estimate
  packer.ts         200k-context budget manager
  planner.ts        pass 1: structured MigrationPlan
  converter.ts      batching, prompts, <file> output parser
  converter-core.ts pass 2: verify/repair loop, scaffold
  review.ts         optional pass 3: consistency review
  state.ts          checkpoint/resume, cost guard
  anthropic.ts      SDK wrapper: retries, caching, accounting
  profiles/         nextjs + fastapi conventions & verification
test/
  fixtures/         mini PHP/jQuery + Python 2 apps
```

## Ground rules

- **Tests**: add/adjust tests for behavior changes. `npm test` must pass; e2e tests must keep
  using the mocked client (no real API calls in CI).
- **Secrets**: never commit API keys or real legacy-project source to `test/fixtures/`. Sensitive
  fixtures (like the `.env` in the PHP fixture) exist only to assert they are excluded.
- **Prompts**: changes to planner/converter prompts should ship with fixture coverage so
  regressions show up in tests.
- **Originals untouched**: the converter must never write inside the scanned legacy project.
- **No new runtime deps** without discussion; the current footprint is deliberately small.

## Adding a conversion profile

1. Add the target to `ModernTarget` (`src/types.ts`) and a profile in `src/profiles/index.ts`
   (conventions, planning hints, static scaffold, `verify()`).
2. Add stack-detection markers in `src/scanner.ts` if the legacy side is new.
3. Add a fixture under `test/fixtures/` and at least: detection test, batch test, and one e2e
   conversion with the mocked client.

## Commits & PRs

- Short imperative subject lines (`Fix packer budget overflow`, `Add ruby profile`).
- Keep PRs focused; open an issue first for larger changes.
- CI runs typecheck + tests + build on Node 20/22 (Linux & Windows) — keep it green.

## Reporting bugs

Open a GitHub issue with the bug-report template: exact command, `--verbose` logs (redacted),
OS/Node versions, and the legacy stack + rough size. That's usually enough to reproduce.
