# Handoff kickoff

`/kickoff [task]` starts the actual `handoff-kickoff` workflow from existing conversation evidence and explicit authority. `/reload` discovers the new prompt in an existing Pi. Structured invocation: `/workflow handoff-kickoff` with `{task,handoff,authority,planner,reviewer}` input via the workflow tool. Agreed proposed planner: `cliproxy/gpt-6.1-sol:high`; independent reviewer: `deepseek/deepseek-flash:high`. Origin Pi conducts assessment/drafting; these steps do not claim a model switch.

Sequence: read-only assessment → source/proposal as data → workflow-owned artifact save → reviewer dispatch (submit receipt immediately) → ordinary durable checkpoint awaiting automatic Rex completion → collect recorded review → coordinator disposition → protected human decision. Four choices: revise, approve, stop, intended-work-done/natural-followthrough. Revision uses exact feedback and existing context, then re-reviews the changed draft. There is no autonomous review-until-clean loop. Agent deadlines are disabled; maxSteps is only a final graph-cycle safeguard. Command deadlines remain liveness safeguards.

## Actual controls

- Assessment/draft/disposition have read/grep/find/ls only, no shell, edit, write or delegation. Only a definition-owned action saves draft files under `.pi/lane/<run>/<uuid>/`. Draft source is never imported or executed by kickoff.
- Review's origin step has subagent/read/rex_finish only. Shared `.pi/agents/delivery-policy.md` is explicitly included in the launched task. The child is instructed read-only, but current Rex subagent does not offer per-child enforced tool isolation. Its thinking level currently inherits the origin and can override `:high`; collection verifies recorded provider/model/thinking in session.jsonl and rejects mismatches rather than accepting a silent substitution. Start from origin thinking `high` for the agreed reviewer. No adapter change is made. Do not claim that role text or tool selection is an OS sandbox.
- Proposed blockers require condition/evidence/consequence/why-before-delivery. Coordinator dispositions cover each id exactly once. Only accepted material blockers prevent successful approval exits. Notes/unknowns don't trigger repair. Unavailable review is recorded unavailable, not clean.
- Human gate has no timer/default approval. It displays original scope/authority, proposal, source, artifact digests, actual review and dispositions in channel-sized blocks. Above channel capacity it explicitly switches to a labelled excerpt and exact artifact paths/digests; inspect the complete files and full decision subject before approving. No silent claim that excerpts are complete. Discuss it before choosing; use Revise with concrete feedback. Approve/followthrough exits recheck artifact digests and blockers. Followthrough additionally requires evidence original work is done. Approval grants only displayed scope/next action, not unrelated work.
- Standalone ends with approved artifacts, not product execution. Parent compositions can consume `approved`/`followthrough` exits without another approval for the same scope, but must bind execution to returned artifact/scope identity. Pi includes resolve before run start; newly authored source cannot be dynamically mounted mid-run. A caller that cannot enforce that binding must not execute it blindly.
- Changing an artifact after presentation fails readback; preserve the failed run and use a newly reviewed proposal, never silently reapprove. Normal pause/resume uses existing frozen graph rules; cancellation is terminal, not a recovery request.

## Async handoff boundary

Dispatch must submit the actual launch receipt before ending its model turn. Leaving an agent step unfinished while a child runs triggers the engine's two missing-submission reminders, even with timeoutMs:null; the establishment run exposed this failure live. A plain checkpoint waits without an active model-result obligation. When the existing automatic Rex completion arrives, the origin coordinator answers that exact ordinary checkpoint with the matching id, then collection verifies artifacts. This wake-to-checkpoint answer is an explicit coordinator contract, not a new automatic adapter binding. No polling, duplicate launch or engine patch. An early answer cannot pass collection without actual completed artifacts. Cancelling a workflow stops continuation; it does not promise to terminate a detached Rex child. Retain/close late child results without restarting cancelled work.

## Legacy lane wiring

`step.workflow.ts` now injects actual role/policy text, uses current Rex task/model/fork arguments, immediately records dispatch, parks at an ordinary checkpoint, collects automatic completion, and saves actual reports through definition-owned actions. Coordinator disposition sits between review and repair/commit. Failed approved checks still justify the existing one fix pass; nonblocking reviewer notes don't. Raw verdict remains evidence in the commit message, not an automatic veto. Role model overrides retain prior precedence; missing role/model blocks rather than substitutes. Legacy lane is not launched or certified end-to-end by these changes. It retains its pre-existing clean-checkout, gate-command and commit behavior; invoking kickoff does not authorize that lane.

Focused local checks (not a live kickoff run):

```sh
NODE_PATH="$HOME/.pi/agent/npm/node_modules" \
PI_WORKFLOWS_ROOT="$HOME/.pi/agent/npm/node_modules/@osolmaz/pi-workflows" \
node --import "$HOME/repos/pi-workflows/node_modules/tsx/dist/loader.mjs" \
  --test .pi/workflows/tests/handoff-kickoff.test.mjs
```

These cover installed loader/graph, stage permissions and four protected choices, disposition routing predicates, artifact-bound approval/followthrough rejection, actual channel normalization for 18k/90k sources, and recorded reviewer-thinking mismatch rejection. They do not demonstrate live Pi approval, cancellation/resume or real reviewer behavior; those use existing engine mechanisms and remain untested for this workflow until an authorized run.

Enforcement limits: semantic materiality, scope honesty and child obedience remain judgments/trusted instructions. Exact output shapes, tool allowlists, artifact readback, human provenance and graph routing are programmatic controls. No engine changes, new settings schema or generic orchestration layer.
