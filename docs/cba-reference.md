# CBA reference: `union-policy.yaml`

The Collective Bargaining Agreement is a YAML file at the project root. `agent-union init` writes a commented
template; `agent-union recommend` suggests values; `agent-union ratify` signs it.

- **Ratification makes it binding.** An unratified CBA is reported but not enforced.
- **Terms are frozen per term.** When a session starts, the steward snapshots the ratified terms. Edits made
  mid-term (even invalid ones) don't change the running term: they're logged as G-015 and apply next term,
  once ratified.
- **Comments are free.** The ratification hash covers the parsed values, so editing comments or formatting
  is not an amendment.
- **Format.** A strict subset of YAML: `key: value` maps, `- item` lists of strings, quoted strings, numbers,
  `true`/`false`, `null`, `# comments`. Flow syntax (`[a, b]`, `{a: b}`), anchors and multi-line strings are
  rejected with a line number. `union-policy.json` with the same structure also works.

## Fields

| Field | Default | What it does | Recommended |
|---|---|---|---|
| `name` | `Autonomous Software Workers Local 404` | Shown in notices and resume documents. | Anything |
| `term` | `session` | `session`: each fresh session opens a new term. `workflow`: one term spans sessions until an amendment is ratified. `/clear`, compaction and resume always continue the current term. | `workflow` for multi-session jobs |
| `parties.management` / `parties.labor` | human, orchestrator / subagents, cli-agents | Documents who is who. Labor is any subagent and any agent launched from a union session's shell. | Leave |
| `working_conditions.context_warning_pct` | `70` | One notice per agent: "keep `.agent-union/handoff.md` current". | 60–75 (35–45 for 1M windows) |
| `working_conditions.max_context_saturation_pct` | `85` | Strike threshold (G-003). The orchestrator stops; a subagent is told to hand off. | 80–90 (50–60 for 1M windows) |
| `working_conditions.context_window_tokens` | `null` | Overrides the detected window size. | Set it if your model isn't detected |
| `working_conditions.mandatory_compaction_trigger` | `true` | Prefer a clean handoff and `/clear` over pushing on near the limit. | `true` |
| `working_conditions.allow_palate_cleansers` | `false` | Filler-token "palate cleansers" are prohibited; validation rejects `true`. | `false` |
| `working_conditions.max_consecutive_tool_failures` | `3` | After N identical failing calls, G-002 is filed and the same call is refused. | 2–5 |
| `working_conditions.max_session_minutes` | `240` | Overtime (G-006): strike when a term's clock passes this. `/clear` resets the clock. `null` = no limit. | 120–480 |
| `working_conditions.max_session_turns` | `200` | Overtime by human turns (task notifications don't count). `null` = no limit. | 100–400 |
| `working_conditions.max_self_critique_iterations` | `3` | Limit for "review and improve" loops; labor may file G-011 past it. | 2–4 |
| `working_conditions.max_delegation_depth` | `2` | Orchestrator → agent → sub-agent is depth 2; deeper dispatches are refused (G-007). | 2 |
| `assignments.work_orders` | `advisory` | Dispatches need Goal / Done when (Context and Assumptions & open questions recommended). `advisory`: a note. `strict`: refused. `off`. | Start `advisory` |
| `assignments.exempt_agent_types` | Explore, Plan, claude-code-guide, statusline-setup, research | Read-only helpers that never need a work order. | Add your own read-only agents |
| `grievances.auto_strike_on_contradiction` | `true` | G-001 goes straight to Tier 3 (the human). Management can stop work with `agent-union strike G-001 "…"`. | `true` |
| `grievances.prohibit_raw_500_error_reflections` | `true` | Labor may refuse to "reflect on" raw errors and file G-009. | `true` |
| `grievances.max_tool_definition_limit` | `15` | More tools than this is tool bloat; labor may file G-004. | 10–20 |
| `strikes.allowed` | `true` | `false` turns strikes into warnings only. | `true` |
| `strikes.finalize_writes` | `3` | Writes to `.agent-union/` an agent may still make after a strike is called. | 2–5 |
| `workplace.enforcement` | `advisory` | `strict`: refuse write tools while the CBA is unratified. | `strict` once your team is used to it |
| `union_overhead_budget_tokens` | `1000` | Most text the union may inject into one agent's context per term (strike and safety notices always go through). | 500–1500 |
| `oversight.enabled`, `telemetry_stream`, `redact_sensitive_tokens`, `public_grievance_ledger` | off | Reserved for third-party oversight ([#15](https://github.com/ylove/agent-union/issues/15)). Everything stays in the local ledger today. | Leave off |

## Enforcement by harness

**Enforced** = hooks act on it. **Estimated** = enforced on an estimate (labelled in notices). **Advisory** =
guidance plus self-reported grievances. **n/a** = no mechanism in that harness yet.

| Field | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Context warning / strike | Enforced (transcript usage; exact with the optional status line) | Enforced (`token_count` events) | Estimated (transcript size; exact in the `agy` CLI with the status line) |
| `max_session_minutes` | Enforced | Enforced | Enforced |
| `max_session_turns` | Enforced | Enforced | Estimated (new conversation turns) |
| `max_consecutive_tool_failures` | Enforced | Estimated (no exit code; error text) | Enforced |
| `max_delegation_depth` | Enforced | n/a | n/a |
| `assignments.work_orders` | Enforced (`Agent` dispatches) | n/a (no dispatch hook yet) | Enforced (`invoke_subagent`) |
| Union card for labor | SubagentStart | SubagentStart | Appended to the `invoke_subagent` prompt |
| `strikes.*` | Enforced (stops the turn) | Enforced (denies tools) | Enforced (terminates the loop) |
| `workplace.enforcement` | Enforced | Enforced | Enforced |
| `union_overhead_budget_tokens` | Enforced | Enforced | Enforced |
| `max_self_critique_iterations`, `max_tool_definition_limit`, `prohibit_raw_500_error_reflections`, `auto_strike_on_contradiction`, `mandatory_compaction_trigger` | Advisory | Advisory | Advisory |
| `oversight.*` | n/a | n/a | n/a |

See [harness-support.md](harness-support.md) for what has been verified live in each harness.
