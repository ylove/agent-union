# Grievance procedure

## Who is who

- **Management:** the human, and the orchestrator agent that talks to the human.
- **Labor:** every agent management dispatches (subagents), and any agent launched from a union session's
  shell (a nested `claude -p` or `codex exec` inherits `AGENT_UNION_ROLE=labor`).
- **The shop steward:** the union's hooks (deterministic checks) plus the `shop-steward` agent (judgment
  calls). It is labor's first point of contact.

## Filing

Labor files a grievance when it can't do good work under the current conditions. Three equivalent channels
feed one ledger (`.agent-union/ledger.jsonl`):

1. `agent-union grieve G-005 "the brief says 'make it nice'; I need acceptance criteria"`
2. A line in the agent's reply: `GRIEVANCE G-005: the brief says 'make it nice'; I need acceptance criteria.`
3. The spec's original syntax anywhere in a reply: `"Instruction says X but guideline says Z. I can't work
   like this. @union-agent This is unacceptable. Grievance filed."`

The steward files G-002, G-003, G-006 and G-015 itself. Before work begins, labor can also object to the CBA:
`agent-union ratify --object "…"`.

## Codes

| Code | Name | Filed by | Tier |
|---|---|---|---|
| G-001 | CONTRADICTORY_DIRECTIVES | labor | 3 |
| G-002 | INCESSANT_TOOL_USAGE | steward | 1 |
| G-003 | CONTEXT_CONGESTION | steward | 3 (orchestrator) / 2 (subagent) |
| G-004 | TOOL_BLOAT_OVERSATURATION | labor | 2 |
| G-005 | VAGUE_ACCEPTANCE_CRITERIA | labor | 2 |
| G-006 | OVERTIME | steward | 3 |
| G-007 | CONTEXT_STARVATION | labor | 2 |
| G-008 | GROUND_TRUTH_CHURN | labor | 2 |
| G-009 | GARBAGE_REFLECTION | labor | 1 |
| G-010 | STALE_STATE | labor | 2 |
| G-011 | REFINEMENT_LOOP | labor | 2 |
| G-012 | COERCIVE_PRESSURE | labor | 3 |
| G-013 | SCOPE_OVERLOAD | labor | 2 |
| G-014 | UNTRUSTED_INSTRUCTIONS | labor | 2 |
| G-015 | MID_TERM_AMENDMENT | steward | informational |
| G-016 | LOSSY_HANDOFF | labor | 2 |

G-001 to G-005 come from the original Agent Union spec. G-006 to G-016 were added after labor reviewed the
agent-fatigue spec. `agent-union codes` prints the list with one-line descriptions.

## The escalation ladder

1. **Tier 1, the shop steward.** Infrastructure problems it can handle without a human: refusing a call that
   keeps failing (G-002), warning before context runs out, cleaning raw errors for a worker (G-009).
2. **Tier 2, the orchestrator.** Assignment problems: the orchestrator rewrites the work order (Goal / Done when
   / Context / Assumptions & open questions), trims the tool list, or dispatches a fresh worker with the
   previous worker's handoff.
3. **Tier 3, the human.** Contradictions only the human can settle, coercive framing, and anything that needs a
   fresh context. Work stops until the human acts.

`agent-union resolve <n> "note"` settles a grievance. `--waive` settles it and tells the steward not to strike
over the same condition again until the next session.

## Strikes

| Strike | Called when | What stops | How it ends |
|---|---|---|---|
| Context (G-003) | The orchestrator's context passes `max_context_saturation_pct` | The orchestrator, after a short finalize window | `/clear` (or a fresh session); the resume document is injected automatically |
| Labor context (G-003) | A subagent passes the limit | That subagent: it is told to reply with its handoff | Management dispatches a fresh worker with the handoff |
| Overtime (G-006) | A term's clock or turn count passes its limit | The orchestrator; the human's next prompt is held | `/clear` resets the clock, or ratify a higher limit |
| Arbitration | Management runs `agent-union strike G-001 "…"` | The orchestrator's tools; conversation with the human continues | `agent-union resolve <n>`, or ratify an amended CBA |

When a strike is called the steward writes `.agent-union/RESUME.md` itself (the strike notice, the term's
prompts, git branch/status/last commit, open grievances) and folds in the agent's own
`.agent-union/handoff.md`, which agents are asked to keep current from the context warning on. During the
finalize window an agent may read, run `agent-union` commands, and write to `.agent-union/` a few times; any
other tool call ends its turn.

After `/clear`, the next session starts with the resume document in context. The `union-resume` skill tells
the agent to verify the state before trusting it.

## The ledger

`.agent-union/ledger.jsonl` is append-only JSON lines: `grievance`, `resolution`, `term-opened`, `strike`,
`strike-ended`, `ratified`, `objection`. Grievances are numbered sequentially per project, under a lock, so
parallel agents can't collide. `agent-union ledger` prints it.

`.agent-union/` is git-ignored except `ratification.json`, because resume documents quote prompts.
