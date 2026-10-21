---
name: union-ratify
description: Before a union job starts, run a bargaining round: labor reviews the CBA against the task and gives feedback, then management amends or ratifies.
---

# Bargaining round

Use this before a large or long job, or when the human asks for labor's view of the CBA.

1. Read `union-policy.yaml` and the task. Note anything the CBA would make hard (for example a
   multi-hour job under a 60-minute overtime limit, or a 1M-token model with an 85% strike threshold).
2. Dispatch one reviewer (a Plan or general-purpose agent) with a work order:
   - **Goal:** review `union-policy.yaml` against the task as labor and say whether you can work under it.
   - **Done when:** the reply lists any objections, each with the field, the problem and a proposed value,
     or says "No objections".
   - **Context:** the task in two or three sentences; the CBA file path.
   - **Assumptions & open questions:** what you are unsure of.
3. Check for objections filed directly: `agent-union ledger | grep objection`.
4. Bring the feedback to the human with your recommendation. Amend the file if they agree.
5. When the human approves, run `agent-union ratify --by "<their name>"`. Ratifying an amendment during a
   strike ends the strike and opens a new term; otherwise the amendment applies from the next session.
