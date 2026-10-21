---
name: union-resume
description: Resume work after an Agent Union strike or /clear, from .agent-union/RESUME.md and the agent's handoff note.
---

# Resume after a strike

1. Run `agent-union resume` (or read `.agent-union/RESUME.md`) and `.agent-union/handoff.md`.
   The union usually injects the resume document automatically after `/clear`; read it in full anyway.
2. Check the strike notice. A context or overtime strike ends once the context is fresh. A strike over a
   dispute (for example G-001) needs the human: they settle it with `agent-union resolve <n>`.
3. Verify before trusting: run `git status`, look at the files named in the handoff, run the tests.
   The document is a snapshot and the files may have moved on.
4. Continue from the handoff's **Next actions**. Re-read the original objective at the top of RESUME.md.
5. Keep `.agent-union/handoff.md` current as you go (Completed / Current state / Next actions / Decisions),
   so the next handoff loses nothing.
