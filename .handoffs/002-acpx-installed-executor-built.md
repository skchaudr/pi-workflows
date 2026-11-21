# Handoff: acpx mode is installed; the acpx step executor is built; step fields are being wired

Written 2026-11-21 12:30 PST by Claude Code (Fable 5.2) for Sab, before compacting a long session. It continues `001-grok-acpx-almost-built.md`; the goal and the acpx facts there still hold. Everything below was read from code, logs, screen captures or command output in this session unless marked otherwise.

Sab's definition of done: "write a pi workflow, have it run through Grok build, run pi, run ACPX and pi workflows together such that. It doesn't have to just be Pi, and it's all streaming through Grok Build, in a way that doesn't accept a dysfunctional state for what is streaming through the TUI, like partially working is not acceptable in this situation."

## Where things are

|                                       | Path                                                                                  | State                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| grok-build acpx work                  | `/Volumes/Mini-SSD/offload/repos/grok-build-acpx`, branch `acpx-tui-slices`           | pushed through `0e750703`; that commit is what is installed. `inspector.rs` has an uncommitted change in progress (agent C, below) |
| Installed build                       | `~/.grok/bin/{grok-fork,grok-traces,grok-pi-acp,grok-acpx-acp}` here and on sab-air   | installed 2026-11-21 05:26 with `scripts/install-fork.sh`; four checksums matched on both machines                                 |
| Previous binaries                     | `~/.grok/bin/{grok-fork,grok-traces,grok-pi-acp}.before-acpx-20261121`, both machines | kept so the old build can be put back                                                                                              |
| pi-workflows                          | `~/repos/pi-workflows`, branch `acpx-executor` (from main `10935d7`)                  | pushed through `b706ec2`; agent S (below) has uncommitted work on top                                                              |
| Not mine, uncommitted in pi-workflows | `scripts/live-e2e.mjs`, `scripts/live-e2e.d.mts`, `test/live-e2e-script.test.ts`      | an earlier agent's unproven fix for the live E2E script; left alone, not staged                                                    |
| Demo flows                            | `/tmp/acpx-demo/{ship,fix,land}.flow.ts`, `input.json`                                | unchanged                                                                                                                          |

Run acpx mode with the installed build:

```bash
grok-fork --agent-cmd ~/.grok/bin/grok-acpx-acp
```

## Handoff steps 1 and 2: done, except the pop-up key

Seen on screen with the installed build (captures `I5*.txt` in `/tmp/acpx-screens/`), on a live `/flow ship.flow.ts` run:

- A running step streams a live preview; the footer shows the step's model while it runs (`grok-4.7 · always-approve`).
- Agent step blocks fold and unfold with `e` (Tab focuses the scrollback first). Shell step blocks unfold to their output when the command printed any.
- The run graph marks finished steps at the gate and at the end.
- An answered gate: the pop-up row moves to Finished and reads `✓✓○✓○✓ 4/6 answered: approve`; the run view shows `✓ answered at accept: approve`, `✓ accept` in the graph, and the choices without key numbers.
- Results show as key/value rows instead of raw JSON, in the pop-up, the run view, the step tree and the step inspector. Empty lists read `(empty)`.
- `[ui].subagent_preview_rows` (default 24) sets the preview height; checked with 6. `GROK_CONFIG` cannot set `[ui]` keys; a config file can.
- The dock already lists the running step; no dock change was needed.

Themes: 129 selectable themes (27 built-in, 102 Pi JSON themes picked with `pi:<name>`) were captured and measured. 204 low-contrast readings remain, none invisible, and every one uses a colour pair the stock pager also draws. Table and captures: `/tmp/acpx-themes/contrast.md`, `index.html` (temporary folder).

Tests: the failures in the full pager and render suites exist on the fork's `main` at `1f2c2b52`, before any acpx commit: 9 in the pager lib (3 of them fail only inside a full run), 3 in the render lib, 25 in `tests/settings_e2e.rs`, 1 doc test. Nobody has looked into why each fails. (`04872286`, named as the base in earlier notes, is 16 commits into the acpx work.)

**Open, waiting on Sab:** which key opens the `/acpx` pop-up. Proposed: F3 (F2 opens settings; only F2 and F8 are bound among function keys; every free Ctrl+letter collides with a terminal convention). Not answered. Binding it needs a rebuild and reinstall.

Seen once, cause unproven: the first `/flow` in a freshly started pager failed with `Cannot apply --model "grok-4.7": the ACP agent did not advertise that model`; the same command worked on the second try. The message comes from acpx (`queue-owner-runtime-*.js`, `assertRequestedModelSupported`). My reading, not proven: Grok answered before its remote model list had loaded.

Not ours to fix: one-line summaries of an agent reply run two sentences together (`…only.Wrote…`) because acpx stores the reply already joined that way.

## Handoff step 3: the executor is built, not yet used

Branch `acpx-executor`, commits `14f781a` and `b706ec2`:

- `src/server/acpx-executor.ts`: `AcpxStepExecutor implements AgentStepExecutor`, over acpx 0.22.0 (`acpx/runtime`: `createAcpRuntime`, `ensureSession`, `setModel`, `startTurn`).
- The model hands in its result through an MCP tool with the same input as Pi's `workflow` tool: `src/server/acpx-submit-mcp.ts` (stdio server) forwards to the executor over a private unix socket (`src/server/acpx-submission-channel.ts`).
- A rejected submission goes back to the model to correct. A turn that ends with no submission gets at most 2 reminders (`MAX_SUBMISSION_REMINDERS`), then a clear error. Abort cancels the turn and reaps the agent.
- It does not support assistant-message completion or `allowedTools`, and it does not stream the agent's text anywhere yet (that is step 5).
- Live proof, `scripts/live-acpx-executor.mjs`, on `grok-build` and on `claude`: `{"answer":5}` rejected, `{"answer":4}` accepted, no process left. Unit tests 18/18; `npm run check` passed.

Facts from a probe (`/tmp/acpx-exec-probe`, temporary):

- acpx's `pi` agent (pi-acp 0.0.33) accepts `mcpServers` but does not pass them to Pi, so Pi steps cannot use this executor. They stay on `RpcStepExecutor` / `InteractiveExecutor`.
- Grok and Pi each have a built-in tool named `workflow`. The MCP one appears as `workflow__workflow` on Grok (found through `search_tool` / `use_tool`) and `mcp__workflow__workflow` on Claude.
- A cancelled Grok turn returned `cancelled` 2 to 4 seconds after `cancel()` and left no process.

The headless question from handoff 001 is answered: the executor is chosen per run at `src/server/workflow-runner-entry.ts:362-407` by execution mode only, and a non-Pi socket client can coordinate a run through a gate (`test/non-pi-coordinator.test.ts`, `10935d7`).

## Running right now (two agents)

**Agent S, step fields and routing.** Sonnet, in Rex tab `acpx-review` (session `session:01a1da28-13cf-78ed-a734-0507ed99215a`, block `block:01a1fbc7-80c6-7488-87c0-4f419a43c5b1`). Brief: `/tmp/acpx-wire-steps-brief.md`. Log: `/tmp/acpx-steps.log` (`S1`…`S5`, then `SDONE`). Settled behaviour:

- An agent step may carry optional `agent` (an acpx agent name) and `model`. A step with neither runs as today.
- A step with `agent` runs through `AcpxStepExecutor`, in interactive and headless runs, through a routing executor in `src/server`.
- Rejected when the workflow is loaded: `agent: "pi"`, `model` without `agent`, and `agent` together with assistant-message completion or `allowedTools`.
- It must add tests, a `docs/WORKFLOWS.md` section, pass the AGENTS.md checks, and end with one live run through the real server: a Grok step, a Claude step, a Pi step and a gate. That run is most of handoff step 4; watching it in piw is still to do.

At 12:22 it had edited `src/workflows/{types,schema,engine,store,composition}.ts` and `src/server/acpx-executor.ts`, added `src/server/agent-routing-executor.ts`, and logged no milestone yet.

**Agent C, centring short inspector output.** Sonnet subagent of the lead session. Brief: `/tmp/acpx-center-brief.md`. Log: `/tmp/acpx-center.log` (`C1`, `C2`, `CDONE`). When a step's output fits in the step inspector it is drawn centred as one block; long or wide output still starts top-left. It must show the result in a debug build (captures `C1.txt`, `C2.txt` in `/tmp/acpx-screens/`). This change is not in the installed build; it needs a release build and `scripts/install-fork.sh` afterwards.

For both: read each milestone line, the diff and the capture before accepting. The lead has not reviewed any of this work yet.

## Next, in order

1. Review agent S's and agent C's results; repair small problems by hand; commit and push. Compact agent S's conversation when it logs `SDONE`.
2. Get Sab's answer on the pop-up key, bind it, then release build, install, and check on screen (this also ships the centring change).
3. Watch the mixed run (Grok, Claude, Pi, gate) in piw. That closes step 4.
4. Step 5: point acpx mode's driver at the pi-workflows server instead of acpx run folders. Plan and fire this as slices per `skills/parallel-slices/SKILL.md`; handoff 001 asked for slices on step 3 as well, and the lead used direct-edit agents instead without weighing it.
5. Step 6: write the build workflow as one pi-workflows file.
6. Merge `acpx-executor` into `main` when Sab says so.

## Temporary files and tabs (listed for Sab; nothing deleted)

- `/tmp/acpx-screens/`, `/tmp/acpx-themes/` (about 900 files), `/tmp/acpx-exec-probe/`, `/tmp/acpx-grok-home-6/` (private config copy with `subagent_preview_rows = 6`), `/tmp/acpx-rv/`, `/tmp/piwd`, `/private/tmp/pbk-*`, `/private/tmp/pbt-*`, the briefs and logs `/tmp/acpx-*.md` and `/tmp/acpx-*.log`, `/tmp/y1-*.txt`.
- Git worktree `/private/tmp/acpx-base-1f2c2b52` (detached at the fork's `main`), registered in `/Volumes/Mini-SSD/offload/repos/grok-build`.
- Two untracked `trace_view_*.snap.new` files under `crates/codegen/xai-grok-pager/src/app/agent_view/snapshots/` in grok-build-acpx.
- Rex tabs that can be closed: `acpx-check`, `acpx-check2`, `acpx-verify`, and `acpx-center` once agent C is done.

## Rules that apply

- Before any cargo build run `df -h /Volumes/Mini-SSD` and stop if under 15 GB is free there. The repos and the shared build folder are on that volume; checking `/` hid a full disk on 2026-11-20. 120 GB was free after the release build. `grok-build/target/debug` (210 GiB by cargo's count) was removed with Sab's approval using `cargo clean --profile dev`; `target/release` there is untouched.
- Build and install through `scripts/install-fork.sh`. It now also installs `grok-acpx-acp`.
- Check any theme change on screen in every shipped theme.
- Do not delete files or directories; list them for Sab.
- No `open -a`, osascript, or sending keys on Sab's desktops. Never print or commit the CLIProxy key or the OpenRouter key.
- acpx session lines under `_auth/*` carry the account email. Never print, forward or log them.
- Co-design screens with full-size (162×49) mockups and get Sab's markup before firing UI slices.
- Commit and push together. Use the trailer `Co-authored-by: claude-code <model>`.
- pi-workflows `AGENTS.md`: `npm run check`, `npm run test:e2e`, the two slophammer commands, one low-cost live E2E; Conventional Commits; required recovery behaviour must not be removed or narrowed.

## How Sab wants this run (his corrections, 2026-11-20 and 21)

- Decide product choices with him, one at a time, each as its own message. Do not ask about things his goal already settles; he asked why the `agent` / `model` fields were ever a question.
- Slice runs are routine. Returned diffs are never perfect; repair small mechanical problems by hand and move on. No verdicts, trials or re-fires for a missing space.
- Never report something as working unless it was seen on the real screen. "Compiles and passes unit tests" is not "works".
- No fire-and-forget: give agents milestones, read each one and its diff or capture during the run.
- Do not describe a defect as if it were intended behaviour.
- No status updates he did not ask for; answer the question he asked.
- Agent context is a cost: every rerun of a long-lived agent resends its whole conversation. Compact agents and the lead session between jobs.
