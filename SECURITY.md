# Security Policy

## Supported versions

restack is pre-1.0; only the latest commit on `main` is supported.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's **Private vulnerability reporting** (Security tab → Report a
vulnerability) with:

- restack version/commit
- affected command (`scan` / `plan` / `convert`)
- minimal reproduction steps and impact

You'll get an acknowledgment within a few days and a fix timeline shortly after.

## Scope notes

- restack reads and sends **legacy project source code** to the configured
  Anthropic-compatible API endpoint. Users are responsible for the sensitivity of
  the code they convert and for their API credentials.
- restack deliberately refuses to pack known sensitive files (`.env`, key files,
  credentials) into model context — reports about missed sensitive-file patterns
  are in scope and welcome.
