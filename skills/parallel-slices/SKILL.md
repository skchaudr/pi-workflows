---
name: parallel-slices
description: Plan, dispatch, integrate, and refine parallel text-only code generation with focused context and explicit file interfaces. Use when the user wants a batch of independent code-generation slices, or to repeat or improve a previous slice-generation run. Workers return text, not autonomous tool-using agents.
compatibility: Requires an authorized model endpoint and a task-local dispatch script for generation; no particular model or Pi extension is required.
---

# Parallel slices

You coordinate: prepare contracts, send independent text-only requests, then review and integrate the returned files. The generation model does not browse, run commands, or edit the repository. This is a working method, not a built-in executable workflow. Do not invent a `workflow start` call for it. Loaded inside an active workflow step, complete that step within its contract; do not start a nested workflow or acquire additional authority.

## Cost rules

Every cheap run followed these. Breaking one is the user's decision, raised before any send with the cost beside the baseline's.

1. **Baseline first.** Read [the run ledger](references/runs.md) before writing prompts. The most recent successful run with a comparable task is the baseline: its runner, input and output per slice, and cost.
2. **One engine.** Send with `scripts/slices.py` in this skill's folder. Write a tasks file that holds only `REPOS`, `TASKS` and optionally `SYSTEM`. Do not copy, patch or replace the engine. If it lacks something, change the engine itself in the pi-workflows repository, in its own commit, and tell the user.
3. **Excerpts, not whole files.** The engine refuses any context entry over 32 KB. Cut a large file to the lines the slice calls with `path#Lstart-end` and summarize the rest in the prompt. Past input was 4k–17k tokens per slice. Above twice the baseline's largest slice, get the user's OK.
4. **Set thinking explicitly.** `--effort` is required. Use `low` for a model that bills reasoning as output unless the user chose otherwise; thinking shares `--max-tokens` with the returned file.
5. **Estimate from real returns.** `--expect-out` is the ledger's returned size for comparable slices plus a thinking allowance. `--rates` is the provider's current price; say where and when you read it.
6. **Compare before sending.** `--baseline` is the ledger's cost per slice. Show the user the dry run's per-slice multiples and batch total, and name the causes of any multiple above 2x: price, input, thinking, output size. The engine refuses to send above 2x; pass `--accept-multiple` only with the number the user approved.
7. **Pilot when the setup changes.** If the model, runner, context policy or thinking level differs from the baseline, send one slice first. Read its usage (tokens in, out, reasoning, cost, finish reason) before sending the rest.
8. **Record the bill.** Save each return's provider usage as `<id>.usage.json`. After review, add the run to the ledger.

A risk you list stays in your recommendation until it is refuted on its own merits. When the user challenges one reason, answer that one; the others stand unless you show they are wrong.

## Start the task

1. Read the goal, repository instructions, existing code, the ledger, and the baseline run's returns. When the repository and task are clear, derive a narrow scope; do not ask the user to restate it.
2. Establish the absolute repository path, base branch, allowed edits and checks, and any commit, push, pull-request, merge, release, or deployment authority. Absent authority means no permission. A generation request alone does not authorize integration or publication.
3. Keep the user's exact provider, endpoint, and model choice. If none is given, prepare the slices and ask once before paid dispatch. Do not change the model to save money; show the cost and let the user choose. Reuse authorization already given for the same work; do not ask once per slice.
4. State the sequence: prepare → review → dry run → pilot if the setup changed → dispatch → integrate and validate. Say which stages the user authorized. Preparing this skill or a plan is not permission to launch a batch.

## Design the slices

- Split by ownership boundaries, not a target count. One new file per slice, one owner per file. Shared-file edits, registration and wiring belong to the coordinator.
- Write each assignment with [the slice template](references/slice-template.md): exact public names, signatures, imports, shared types, behavior, edge cases, tests and return format.
- Define each shared interface once and paste the same text into every dependent prompt. A slice written against an interface not yet built or wired (for example a wire format the server does not emit yet) waits until that interface exists.
- Check every excerpt against current source: derives, visibility, module paths, optional fields, available packages.
- Resolve cross-slice changes before sending, such as new keys in both help and the keyboard audit.

## Review before dispatch

An independent reviewer, in a tab the user can watch, checks the prompts with [the review brief](references/review-brief.md) as written. Add facts and paths to it; never remove or narrow a check. Fix the must-fix findings. When the reviewer says to drop, merge or redesign a slice, bring that to the user. Re-review any prompt you change beyond a wording fix.

## Dispatch

```bash
python3 <skill>/scripts/slices.py TASKS.py --model <id> --effort low --rates <in>,<out> --expect-out <tokens> --baseline <usd> --dry-run
```

Drop `--dry-run` to send; add `--only <ids>` for a pilot, retry or follow-up slice. The engine sends each slice as one completion request with no tools (Omit tools and tool execution entirely), prints the endpoint and model but never the key, retries transient errors a bounded number of times, stages returns in `<tasks>_out/` with the raw text and `<id>.usage.json`, prints a line per send and return plus a waiting line every 20 seconds, treats empty, cut-off and incomplete returns as failures, and exits nonzero if any slice failed. It never executes generated output. Send only context permitted for that service and no secrets. Match `SYSTEM` to the return format. A timed-out request may still be billed.

Read every dry-run prompt in `<tasks>_out/_prompts/`, not just the sizes. Run the engine in a named tab the user can watch (for example a Rex tab), tell them its name, and leave it open. Do not pipe its output through anything that holds it until exit.

## Review and integrate

1. Account for every slice: returned, failed, cut off, or skipped. "Returned" means text arrived, not that it compiles.
2. Check public interfaces, reuse of existing types, dependency rules and requested tests. Repair small mechanical problems yourself; send a focused correction only when it helps. Do not regenerate accepted files because another slice failed.
3. Integrate through one coordinator: register modules, connect state and events, adapt real call sites.
4. Run the repository's real format, compile, lint and test commands, with the new modules registered so their tests compile.
5. Validate behavior in the running product. For a keyboard UI check Tab **and Shift+Tab**, focus-specific keys, both directions, wrap or clamp, empty states, Enter and Esc, modifiers, modal priority and global shortcuts. Report what was not exercised.
6. Turn a real gap into a narrow follow-up slice with updated contracts and dispatch only that slice within existing authorization; ask if it changes model, spending or scope.

[The piw run lessons](references/piw-lessons.md) show why compile success and interaction success are separate.

## Finish

Report what was generated and integrated, checks actually run, blockers, artifact paths, and the actual cost from the usage files with its multiple against the baseline. Add the run to the ledger. Do not claim live verification from compilation, or integration from staged files. On cancellation stop further dispatch, keep what was received, and name any requests still in flight.
