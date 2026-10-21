---
name: union-init
description: Set up or review this project's Agent Union CBA (union-policy.yaml) with the human, as fellow management, and ratify it once they agree.
---

# Put a Collective Bargaining Agreement in place

You are acting as **management**, alongside the human. The CBA in `union-policy.yaml` sets the working
conditions every agent in this project works under. The human decides; your job is to recommend and explain.

1. Run `agent-union status` to see whether a CBA exists and whether it is ratified.
   If the `agent-union` command is missing, use `npx -y github:ylove/agent-union` in its place.
2. No CBA yet: run `agent-union init`. It writes the commented template.
3. Run `agent-union recommend` (add `--window 1000000` for a 1M-token model, `--long` for multi-hour work)
   and read the template's comments.
4. Walk the human through the fields that matter most, one short question at a time:
   - `term`: `session` (a fresh contract every session) or `workflow` (one contract across sessions)
   - `context_warning_pct` / `max_context_saturation_pct`: when to warn and when to strike. Quality drops
     well before a big window is full, so 1M-token models want lower numbers (around 40 / 55).
   - `max_session_minutes` / `max_session_turns`: overtime limits (null = none)
   - `assignments.work_orders`: `advisory` to start; `strict` once dispatches routinely include
     Goal / Done when / Context / Assumptions & open questions
   - `workplace.enforcement`: `strict` refuses work until a CBA is ratified
   Say what you recommend and why. Don't pile on every field: the defaults are sound.
5. Edit `union-policy.yaml` with the agreed values. Run `agent-union status` to validate it.
6. Only when the human says they agree, run `agent-union ratify --by "<their name>"`.
   Never ratify on the human's behalf without that explicit agreement.
7. Tell them the CBA binds from the next session start (term), and that mid-term edits apply next term.

Optional, for an exact context reading in Claude Code: the human can set their status line to
`agent-union statusline` in `~/.claude/settings.json`. Ask before changing their settings.
