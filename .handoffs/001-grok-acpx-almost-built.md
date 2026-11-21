# Handoff: grok acpx mode is almost built; next is pi-workflows as its engine

Written 2026-11-20 by Claude Code (Opus 5.5) for Sab, to start a fresh session. Facts were read from code, the run folders and the live pager on sab-mini today.

Sab, 2026-11-20, on why this exists: "It was such a bummer how Pi workflows could not use other harnesses besides Pi ... and then this came along. Same maintainer."

## The goal

- **Engine:** pi-workflows. Gates stay in the same run (`/workflow answer`), with pause/resume, durable SQLite state, composition and `controlLoop()`.
- **Agent steps:** acpx, so any harness or model (Claude, Codex, Grok, Droid) can be a step.
- **Interface:** the grok-build pager's own transcript. "acpx mode" replaces Grok chat streaming in that pane. An overseeing agent can live in a separate Rex pane.
- **Big-picture view:** the `/acpx` modal is kept, as text and events, to be opened as a pop-up from a keybinding. piw stays the graph view.
- **First workflow to run:** the one we build with. Research → slices with context → fire → land with review and integration tests → test the real outcome.

## Where things are

|                      | Path                                                                                                        | State                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| grok-build acpx work | `/Volumes/Mini-SSD/offload/repos/grok-build-acpx`, branch `acpx-tui-slices`                                 | `26053d16`, pushed, clean. 18 commits, about 21,600 lines over 53 files |
| Build output         | `/Volumes/Mini-SSD/offload/repos/grok-build/.git/pi-grok-cargo-target/debug/{xai-grok-pager,grok-acpx-acp}` | debug build; not installed                                              |
| pi-workflows         | `~/repos/pi-workflows`, `main` (origin = `skchaudr/pi-workflows`, upstream = `osolmaz/pi-workflows`)        | `3e3a37a`, pushed. 25 ahead of upstream, 0 behind                       |
| Demo flows           | `/tmp/acpx-demo/{ship,fix,land}.flow.ts`, `input.json`, `slug.py`                                           | the ship → fix → land chain                                             |
| acpx runs            | `~/.acpx/flows/runs/<run>/`                                                                                 | acpx 0.22.0                                                             |

How the live pane runs (Rex pane "acpx mode", cwd `/tmp/acpx-demo`):

```bash
/Volumes/Mini-SSD/offload/repos/grok-build/.git/pi-grok-cargo-target/debug/xai-grok-pager --agent-cmd /Volumes/Mini-SSD/offload/repos/grok-build/.git/pi-grok-cargo-target/debug/grok-acpx-acp
```

## What is built and verified live

**acpx mode** is an ACP agent, `grok-acpx-acp`, that runs acpx flows and shows them in the pager transcript.

Code is in `crates/codegen/xai-grok-pager-bin/src/bin/grok-acpx-acp/`:

- `main.rs` (written by hand);
- `agent.rs`, `driver.rs`, `project.rs` (from slices, then fixed by hand).

What it does:

- **Commands:** `/flow <file> [task or JSON]`, `/runs`, `/open <run id>`, `/answer <label>`, `/acpx-help`. A plain message runs the default flow.
- **Steps:** each step is an inline subagent block with a live 24-row preview of its transcript (prompt, thinking, tool calls, message). Enter opens the full subagent view.
  - The preview is `scrollback/blocks/subagent_preview.rs`, wired through `app/acp_handler/subagent_activity.rs`.
  - Blocks with a preview are not folded into "Ran N subagents" (`scrollback/state/verb_group.rs`).
- **Gates:** a gate is a pop-up question (`x.ai/ask_user_question`). Each answer starts the next flow file named in the checkpoint's `next`.
- **Run history:** the pager's resume picker lists past runs (`session/list`), and `load_session` replays a run folder.
- **Verified:** ship → reject → fix → approve → land ran end to end inside the pager in 1m52s.
- **Tests:** 38 `grok-acpx-acp`, 308 pager subagent and 53 verb-group tests pass.

**The `/acpx` modal** comes from the first two slice rounds:

- Files: `views/acpx_modal*`, `scrollback/blocks/acpx_flow.rs`, `app/dispatch/acpx_run.rs`, `slash/commands/acpx.rs`, `acp/acpx_feed.rs`, `acpx/{bundle,graph,launch,sessions}.rs`.
- Layout: runs grouped by state, with a step-mark strip, on the left; the run's gate, stages, last result and input on the right.
- Sab, after seeing it on 2026-11-20: keep it.

`scripts/acpx-piw.py` in grok-build-acpx lets piw show acpx run folders.

## Not finished

- The pager's bottom dock ("Subagents" section, `views/dock/mod.rs`) still pins running steps to the bottom. Sab does not want steps pinned. The dock is turned on by the remote `dock_enabled` setting, because `~/.grok/config.toml` sets no `features.dock`.
- The mermaid graph in the run heading never marks finished steps.
- The footer shows the model as "unknown".
- The 24-row preview cap is a constant (`PREVIEW_ROWS` in `scrollback/blocks/subagent.rs`), not a setting.
- The wider pager test suites and snapshots have not been run on this branch.
- Not installed with `scripts/install-fork.sh`, not merged.
- Modal defects:
  - "N needs you" counts gates that were already answered by starting the next flow.
  - The last result and the input show as raw JSON.
  - Gate questions are cut off.
- The modal is not yet on a keybinding.
- pi-workflows:
  - `test/e2e/package-resources.e2e.test.ts` failed 3 of 4 on 2026-11-20, cause not looked at.
  - The untracked slice output `task-scripts/piw-tui_out/{_returns/node_walk.md,tui/src/ui/node_walk.rs}` is not committed.

## acpx facts that shaped the design

- **No resume:** acpx cannot continue a run that stopped at a checkpoint. The runner marks it `waiting` and exits, and `acpx flow run` always starts a new run at `startAt`. That is why acpx mode chains flow files, and why pi-workflows should be the engine.
- **Run folders:** events are written live, but acpx prints nothing to stdout until the run ends. acpx mode finds a new run by its folder's `manifest.json` `flowPath`, and reads `trace.ndjson` (`run_completed`, `run_failed`).
- **Checkpoint output:** a large checkpoint output goes in `outputArtifact`, not `outputInline`. The driver reads both.
- **Config options:** `configOptions` must be an array, `[{configId:"reasoning_effort",value:"low"}]`, with `modelId` set separately.
- **Secrets:** session lines under `_auth/*` carry the account email. Never print, forward or log them; the driver skips them.

## The pi-workflows bridge (not started)

`docs/plans/2026-11-16-acp-harness-adapter-aha.md`: `WorkflowEngine` takes any `AgentStepExecutor`, and acpx's `AcpRuntime` already matches it one-to-one.

| Step needs      | acpx provides                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| step identity   | `requestId`                                                                                             |
| time limit      | `timeoutMs`                                                                                             |
| stopping        | `cancel()`                                                                                              |
| prompt accepted | `promptStarted`                                                                                         |
| live progress   | `events`                                                                                                |
| final result    | `completed`, `cancelled` or `failed`, matching the engine's `ok`, `failed`, `timed_out` and `cancelled` |

The executor implementations today are `InteractiveExecutor` (`src/server/workflow-runner-entry.ts`) and `RpcStepExecutor` (`src/server/rpc-executor.ts`).

Open question: can the pi-workflows server run a workflow with no Pi conversation attached?

## Next, in order

1. Finish acpx mode: the dock, the graph, the footer and the cap setting. Run the full pager suites, install it and check it on screen.
2. Fix the modal's defects and put it on a keybinding as a pop-up.
3. Answer the headless question. Then build the `AgentStepExecutor` adapter over `createAcpRuntime` and `startTurn` (acpx as a library), as slices.
4. Prove the bridge: one pi-workflows workflow with a Grok step, a Claude step and a gate, continuing in the same run, watched in piw.
5. Point acpx mode's driver at the pi-workflows server instead of acpx run folders. The rendering (previews, gate pop-up, plan) stays.
6. Write the build workflow as one pi-workflows file.

## Rules that apply

- Run `df -h /` before any cargo build; stop if under 15 GB free.
- Build and install through `scripts/install-fork.sh`.
- Check any theme change on screen in every shipped theme.
- Do not delete files or directories; list them for Sab.
- No `open -a`, osascript, or sending keys on Sab's desktops. Never print or commit the CLIProxy key.
- Co-design screens with full-size (162×49) mockups and get Sab's markup before firing UI slices. Get one independent review before firing any slices.
- Commit and push together. Use the trailer `Co-authored-by: claude-code <model>`.
