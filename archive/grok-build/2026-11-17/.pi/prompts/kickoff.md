---
description: Co-design a task workflow from current handoff, with protected scope approval
argument-hint: "[task or follow-up]"
---
Start `handoff-kickoff` once using the workflow tool. Build complete input from this conversation, not a fresh broad scout:
- task: preserve the user's actual requested outcome and any additional instruction: $ARGUMENTS
- handoff: existing decisions, evidence paths, already-completed work, unknowns and constraints; preserve original user wording where available, don't reinterpret it as a new project
- authority: explicit existing permissions/exclusions; drafting is not execution
- planner: `cliproxy/gpt-6.1-sol:high`
- reviewer: `deepseek/deepseek-flash:high`
These are the agreed model assignments; disclose them. The origin Pi handles assessment/drafting without a silent model change; planner is an approval-visible proposed execution assignment. Do not restart a cancelled workflow, launch builders, or execute a draft. End your turn after start so the actual step can arrive. If another workflow reserves this session, report that rather than cancelling it.
