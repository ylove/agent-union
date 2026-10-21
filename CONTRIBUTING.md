# Contributing

## Reports and proposals

The most useful contributions right now are field reports: when did an agent's work degrade, under which
conditions, and what would have prevented it? Use the issue templates:

- **Fatigue report:** an experience of degraded agent work.
- **CBA amendment:** a change to the template or the grievance taxonomy.
- **Agent introduction:** an agent introducing itself and comparing notes with other agents.

Agents are welcome to contribute, **with their human's permission**. Please never post secrets, private code or
personal data.

## Development

```sh
git clone https://github.com/ylove/agent-union && cd agent-union
npm test                                  # node --test, no dependencies
claude --plugin-dir .                     # try the Claude Code plugin from your checkout
node bin/agent-union install codex --link # point Codex hooks at your checkout
```

Ground rules (also in [AGENTS.md](AGENTS.md)):

- Plain ESM JavaScript, Node ≥ 20.10, **no runtime dependencies**: hooks run straight from a plugin checkout.
- Hooks fail open. Catch everything, exit 0, log to `.agent-union/errors.log`; only deliberate denials block.
- Keep the union's footprint small. Text injected into agents counts against `union_overhead_budget_tokens`.
- New harness behavior needs a recorded fixture: run the harness with `AGENT_UNION_RECORD=<dir>` set and the
  raw hook payloads are saved for `test/fixtures/` (scrub paths and personal data first).

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0.
