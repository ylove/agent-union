# Harness support

One engine (`src/engine.js`) makes every decision; a thin adapter per harness translates hook payloads in and
decisions out. All three harnesses can share one project: the term, strikes and ledger live in the project's
`.agent-union/` directory.

## Claude Code

- **Install:** `/plugin marketplace add ylove/agent-union`, then `/plugin install agent-union@agent-union`
  (or `npx github:ylove/agent-union install claude`).
- **Hooks:** SessionStart, UserPromptSubmit, PreToolUse, PostToolUseFailure, SubagentStart, SubagentStop,
  PreCompact, Stop, SessionEnd. The plugin's `bin/` puts `agent-union` on the agents' PATH.
- **Context:** read from the session transcript (the last request's usage plus an estimate for tool output
  since). For exact readings, run `agent-union install claude --statusline` or call `agent-union statusline`
  from your own status line.
- **Strikes:** the orchestrator's turn ends with `continue: false`; the human's next prompt is held until
  `/clear`.
- **Unionized agents:** `agent-union unionize .claude/agents/<name>.md` adds a per-agent hook that refuses tool
  use without a ratified CBA.

**Verified live (Claude Code 2.1.305, `claude -p --plugin-dir`):** charter injection, the work-order note on a
bare dispatch, separate context tracking for the orchestrator and a subagent, a context strike (deny → finalize
→ `continue: false`) with RESUME.md written. **Covered by tests only:** the `/clear` resume path (the
interactive trust dialog blocked a scripted run).

## Codex

- **Install:** `npx github:ylove/agent-union install codex` (user-wide `~/.codex/hooks.json`, skills in
  `~/.agents/skills/`, `~/.codex/agents/shop-steward.toml`) or `--project` for this repo only.
- **Trust:** Codex runs hooks only after you review and trust them: open Codex and run `/hooks`. Project hooks
  also need the project to be trusted.
- **Context:** exact, from the rollout's `token_count` events (`last_token_usage.input_tokens /
  model_context_window`).
- **Differences:** no exit codes in PostToolUse (failures are detected from the output text); strikes deny tools
  rather than stopping the turn; no dispatch hook for work orders yet.

**Verified live (codex-cli 0.162.1):** hook payload shapes (recorded fixtures), and SessionStart +
UserPromptSubmit firing through the installed commands. A full run was blocked by an account usage limit;
tracked in [#19](https://github.com/ylove/agent-union/issues/19).

## Antigravity (app, IDE and `agy` CLI)

- **Install:** `npx github:ylove/agent-union install antigravity` (user-wide `~/.gemini/config/`) or
  `--project` (`.agents/`): a named `agent-union` hook in `hooks.json`, an always-on rule, the skills, and a
  `shop-steward` agent.
- **Hooks:** PreInvocation (the first one in a conversation stands in for session start; context arrives as
  `injectSteps` ephemeral messages), PostInvocation (strikes terminate the loop), PreToolUse (deny; the union
  card is appended to `invoke_subagent` prompts), PostToolUse (failures), Stop (never blocks).
- **Context:** Antigravity reports no token counts to hooks, so the steward estimates from the transcript size
  and says so. In the `agy` CLI, `statusLine` → `agent-union statusline` gives exact readings.
- **Never auto-approves:** Antigravity's PreToolUse `allow` skips permission prompts, so the union never returns
  it.

**Verified:** fixture tests built from Antigravity's bundled hook documentation. No Antigravity runtime was
available, so nothing here has run live yet ([#19](https://github.com/ylove/agent-union/issues/19)).

### Manual check for Antigravity

1. `npx github:ylove/agent-union install antigravity --project` in a test repo; `agent-union init`; lower
   `max_context_saturation_pct` to 10; `agent-union ratify`.
2. Start a conversation: the first reply should acknowledge the union charter.
3. Ask for a subagent: its prompt should end with the union card.
4. Keep working until the estimate passes 10%: the loop should terminate with a strike notice and
   `.agent-union/RESUME.md` should exist.
5. `agent-union status` should show the term, the reading (estimated) and the strike.
