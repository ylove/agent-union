# Agent conventions for agent-union

## Code
- Plain ESM JavaScript, Node >= 20, **zero runtime dependencies**. Hooks run straight from a plugin
  checkout, so nothing may require `npm install`.
- Hooks must fail open: catch everything, exit 0, log to `.agent-union/errors.log`. The only blocks are
  deliberate denies decided by the steward.
- Keep the union's own footprint small. Everything injected into an agent's context counts against
  `union_overhead_budget_tokens`.
- Tests: `node --test` (files in `test/`). Fixtures of real hook payloads live in `test/fixtures/`.

## Layout
- `src/` engine, adapters and installers; `bin/agent-union.mjs` is the CLI.
- `skills/`, `agents/`, `hooks/`, `.claude-plugin/` make the repo root a Claude Code plugin.
- `site/` is the GitHub Pages site; `docs/` holds the reference docs; `docs/specs/` holds the original inputs.

## Process
- Commit and push after each meaningful step; reference the tracking issue (`Closes #n`).
- Licence: Apache-2.0.
