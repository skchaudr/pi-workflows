# Handoff: all work is on main; slice runs are hardened; nothing lives on a branch

Written 2026-11-21 23:20 PST by Claude Code (Opus 5.5) for Sab. It continues `002-acpx-installed-executor-built.md`. Everything below was checked with git, ssh or command output at the time of writing unless marked otherwise.

## Rule: work on main

Sab does not want his projects living on branches. Commit to `main` and push. Do not create a branch for a feature, a slice run or a worker. If something already sits on a branch, fast-forward or merge it into `main` and push. Do not open a pull request. Agents in these sessions created `acpx-executor` (pi-workflows) and `acpx-tui-slices` (grok-build), which hid finished work from `main` and from sab-air, and Sab had to say "stop living on branches" more than once.

## Where things are

|                     | Path                                                    | State                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi-workflows        | `~/repos/pi-workflows`, on `main`                       | `origin/main` = `22e4a65`, which holds all of `acpx-executor` (fast-forwarded and pushed 23:05). sab-air's checkout is on `main` at `22e4a65`.                                                                                                                 |
| pi-workflows, dirty | same checkout                                           | uncommitted: `src/server/{acpx-executor,server,state}.ts`, `src/workflows/queue.ts`, `test/{acpx-executor,run-queue,workflow-recovery,live-e2e-script}.test.ts`, `scripts/live-e2e.{mjs,d.mts}`. The server worker's fixes in progress; they commit to `main`. |
| grok-build          | `origin/main` = `316701f2`                              | merge of `acpx-tui-slices` into `main`, pushed. The merged tree has **not been compiled**.                                                                                                                                                                     |
| grok-build, acpx    | `/Volumes/Mini-SSD/offload/repos/grok-build-acpx`       | checkout still on branch `acpx-tui-slices`; uncommitted `grok-acpx-acp/{agent,project}.rs`, `piw/mirror.rs`; untracked `task-scripts/piw-in-grok_out/`. Owner of those edits not confirmed. Move it to `main` once they are committed.                         |
| grok-build, main    | `/Volumes/Mini-SSD/offload/repos/grok-build`, on `main` | local checkout at `913885e1`, behind `origin/main`; needs `git pull --ff-only`.                                                                                                                                                                                |

The two branches (`acpx-executor`, `acpx-tui-slices`) still exist on the remote. Their content is on `main`; delete them once nothing is checked out on them.

## Slice runs: what changed tonight

The 2026-11-21 Neon six-slice run cost $8.83, at least 8x per slice over every earlier Argon run (at most $0.17 per slice). Causes: a new runner copy that dropped the 32 KB per-file context cap, thinking left at the model default (it also hit the 64k output cap and cut off three slices), a dry-run estimate shown without past costs, and a review brief that said "Do not suggest trimming context". The full account is in `skills/parallel-slices/references/runs.md`.

Now on `main`:

- `skills/parallel-slices/scripts/slices.py` is the only engine; tasks files hold data only. It refuses any context entry over 32 KB (cut with `path#Lstart-end`), requires `--effort`, `--expect-out` and `--baseline`, reads the live price from OpenRouter, prints an aligned cost table (files and sizes, tokens in and out, estimate, multiple of baseline), counts down a fixed 30 s before sending (Ctrl-C sends nothing), shows actual against estimated cost per return, refuses above 2x baseline without `--accept-multiple`, and appends every finished send to `~/.local/state/slices/runs.jsonl`.
- Read-only commands, on PATH as `~/.local/bin/slices` on both the Mini and sab-air:

```bash
slices runs
slices status 1
slices ledger
slices show TASKS.py --model google/gemini-4-argon --effort low --expect-out 15000 --baseline 0.17
```

- `references/runs.md` is the ledger of every run; `references/review-brief.md` is the fixed pre-dispatch review, starting with baseline and cost checks.
- Small known gap: `slices` with no command prints usage but exits 0, not 2.

The six Neon returns (`activity`, `start`, `gate` whole; `client`, `driver`, `mirror` cut off or resent) are in `grok-build-acpx/task-scripts/piw-in-grok_out/` and are not integrated. The Opus review of those prompts is at `/tmp/piw-slices-review.md`.

## Open

1. Compile and test grok-build `main` at `316701f2`.
2. Let the server worker finish and commit on pi-workflows `main`; then run `npm run check` (two `test/rpc-executor.test.ts` failures were seen earlier from that in-progress work).
3. Commit or discard the uncommitted edits in `grok-build-acpx`, switch that checkout to `main`, pull the other grok-build checkout, and delete the two remote branches.
4. Sab's nvim template `~/.config/nvim/templates/parallel-slices-with-context.py` still copies an engine into each runner; point it at `slices.py` or retire it.
