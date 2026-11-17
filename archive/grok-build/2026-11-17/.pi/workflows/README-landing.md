# Landing the three contributions

Entry point: **`landing.workflow.ts`**. Authoring only so far; not run live.

```text
separate same-model preparation Pi
  → coordinator sanity-check + human packet approval
  → three parallel builder/reviewer workflows + independent check design
  → join → integration → independent overall-goal review
  → serial release checks → merge/push → install-fork.sh → screen verification
```

Approval authorizes the displayed implementation and delivery scope. There is
no separate approval-to-launch ceremony or second delivery gate.

## Pieces

- `prepare-landing`: delegates shared investigation to one fresh Pi using the
  coordinator's model. Produces F3, Cass and Claude packets. The coordinator
  sanity-checks them; the human approves, revises or stops.
- `launch-landing`: creates isolated worktrees and dispatches three visible
  builder subagents plus one independent acceptance designer. Automatic result
  messages join them in the coordinator; no polling or manual integration start.
- `lib/task-run` / `reviewed-task`: same composition for all three packets.
  Builders port the named existing contribution and finish its gaps. Independent
  clean-context reviewers feed repairs back to the same builder. Details stay
  local. No Cargo in these lanes.
- `acceptance-checks`: goals first, no builder reports; a few decisive checks,
  with missing tests identified for integration. No Cargo here either.
- `integrate-landing`: one owner combines commits and adds missing checks;
  independent final goal audit, serial release tests, merge/push, one normal
  `scripts/install-fork.sh` for both binaries on Mini and Air, then actual screens.

A blocked feature, exhausted approved review bound, failed final audit or command
failure returns evidence for scoped follow-up. Cancellation stops continuation.
Do not repeat an installation without inspecting its actual outcome. Review
against requested behaviour, not a zero-defect ideal or speculative hardening.

## When execution is authorized

`landing-input.example.json` contains proposed model assignments and review
rounds, not silently accepted defaults. The packet gate displays them and the
merge/push/install scope. The planner identity must match the coordinator.

The existing `prepare-landing-pi.sh` launcher now opens the **landing coordinator**
using `PI_PROVIDER`, `PI_MODEL` and `REX_SESSION`; it passes the example input and
starts `landing`, which waits for packet approval before implementing anything.
Alternatively start `landing.workflow.ts` in the coordinator with the example
input plus the exact intended `rexSession`.

No workflow, agent, authoring tests, Cargo or installation has been run for this
revision. Existing offline tests predate these control-flow changes; their old
passing count is not verification of this revision. The five earlier commits
preserve the oversized first attempt, not evidence of live readiness.
