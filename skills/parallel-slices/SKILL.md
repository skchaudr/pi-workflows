---
name: parallel-slices
description: Plan, dispatch, integrate, and refine parallel text-only code generation with focused context and explicit file interfaces. Use when the user wants a batch of independent code-generation slices, or to repeat or improve a previous slice-generation run. Workers return text, not autonomous tool-using agents.
compatibility: Requires an authorized model endpoint and a task-local dispatch script for generation; no particular model or Pi extension is required.
---

# Parallel slices

Use Pi as the coordinator: inspect the project, prepare contracts, dispatch independent text-generation requests, then review and integrate the returned files. The generation model does not browse, run commands, or edit the repository. This is a working method, not a built-in executable workflow. Do not invent a `workflow start` call for it.

## Start the task

1. Read the user's goal, repository instructions, existing implementation, and any previous dispatch script and results. Derive a narrow scope when the repository and task are clear; do not ask the user to restate them.
2. Establish the absolute repository path, base branch, allowed edits and checks, and any commit, push, pull-request, merge, release, or deployment authority. Absent authority for those consequential actions means no permission. A generation request alone does not authorize integration or publication.
3. Keep the user's exact provider, endpoint, and model choice. If a choice is missing, prepare the slices and ask once before paid dispatch. Do not substitute a model because a previous run was inexpensive, assume equivalent quality, or treat an intentional model choice as a bug. Reuse authorization already given for the same work; do not ask once per slice.
4. State the sequence briefly: prepare independent slices → inspect the dry run → dispatch → review returns → integrate and validate within scope. Make clear which stages the user authorized. Preparing this skill or a plan is not permission to launch a batch.

When loaded inside an active workflow step, complete that step within its contract; do not start a nested workflow or acquire additional authority.

## Design the slices

- Split by independently implementable ownership boundaries, not a target count or line count. Ten or eleven is not a requirement. Keep tightly coupled work together rather than manufacturing parallelism.
- Prefer one new file per slice. Give every output one owner. Existing shared-file edits, module registration, event routing, and final wiring belong to the coordinator unless explicitly assigned to one slice.
- Use [the slice template](references/slice-template.md) for each assignment. Specify exact public names, signatures, imports, shared types, behavior, edge cases, tests, and return format. State who owns integration and what it must call.
- Define shared interfaces once and include the same contract in every dependent prompt. A slice must not depend on another slice's unwritten implementation or invent a competing type. If its interface cannot be fixed yet, sequence that work instead.
- Attach the smallest **complete** context needed: real type declarations, relevant handler bodies, dependency versions, and a representative house-style file. Check derives, visibility, module paths, ownership, optional fields, and available crates/packages against source. Include called helpers when their behavior matters.
- Verify excerpts against the current source. Do not silently dispatch with missing or truncated required context. Deliberately summarize irrelevant implementation rather than cutting off a required contract. A genuinely self-contained geometry/helper slice may need no attached files.
- Resolve cross-slice changes before dispatch. For example, new navigation keys must appear consistently in help and an independent keyboard audit's reserved-key list. Document replacements of existing behavior, not just additions.

## Prepare and inspect the dispatch

Reuse a suitable task-local runner; adapt it or write a small task-specific script if none exists. Do not create a new orchestration framework just to send independent requests. The historical `task-scripts/piw-tui.py` in the pi-workflows source checkout is a worked example, not a required installed dependency or a command to rerun for unrelated work.

The runner should provide:

- Independent completion requests containing system instructions, the slice contract, and its context. Omit tools and tool execution entirely. Match system instructions to the return format; a Markdown-document slice must not also be told to return code fences only.
- Explicit endpoint/model configuration and credentials resolved for that provider. Print the selected endpoint and model, never the key. Do not let another installed credential silently change the provider. Send only context permitted for that external service; exclude secrets.
- A dry run showing selected slice ids, output paths, and prompt sizes without contacting a model. Selective dispatch permits a pilot, failed-slice retry, or later follow-up slice without paying for the whole batch again.
- Parallelism appropriate to provider rate limits, request timeouts, and bounded transient retries. A timed-out generation may still be billed; retries are not free. Do not blindly restart the whole batch.
- Staged outputs separate from production source, plus the full raw returned text for inspection. Never execute generated output as part of dispatch. Preserve successful work when another slice fails. Track which attempt produced each accepted file so a stale staged result is not mistaken for a fresh success; a simple run directory or result log is enough.
- Visible progress while requests are out. Print a line when each slice is sent, a line when each returns (id, seconds, tokens in and out, lines per returned file, or the failure), and a periodic line naming the slices still pending with their elapsed time. A batch that prints nothing until the end is a black box for the user.
- Detection of empty and provider-truncated returns. Preserve partial text for diagnosis, but do not call it a completed file. Report failed ids explicitly; new runners should exit nonzero on partial failure. These are runner checks, not a demand that the user manually sanitize every response.

Run the dispatch where the user can watch it. When a terminal multiplexer with a CLI is available (for example a Rex tab or pane), start the runner there in a named tab instead of as a hidden background command, tell the user the tab's name, and leave the tab open afterwards so the per-slice results stay readable. Do not pipe the runner's output through anything that withholds it until exit.

Run the dry run and inspect actual prompts, not just sizes. Confirm context coverage, output ownership, return formats, and the selected provider/model before dispatch. A one-slice pilot is useful when the endpoint or contract is unproven, not a mandatory extra paid stage for every batch.

If reporting cost, identify the source/date of model-specific rates and output/retry assumptions. Otherwise say the cost is unknown. A hardcoded estimate is neither the actual bill nor a spending ceiling; do not promise a previous run's price or line count.

## Review and integrate

1. Account for every selected slice: returned, failed, incomplete, or deliberately skipped. Inspect the actual files. “Returned” means text was received, not that it compiles or works.
2. Check public interfaces, reuse of existing types, dependency rules, and requested tests. Repair small mechanical problems directly within permission; dispatch a focused correction only when it helps. Do not regenerate accepted files merely because a different slice failed.
3. Integrate through one coordinator. Use a scratch worktree if it protects concurrent work; it is not mandatory. Register modules, connect state and event handling, and adapt the real call sites. Do not pretend this integration has a fixed line count.
4. Run the repository's actual format, compile, lint, and test commands. Run unit tests together after registering the modules; unreferenced generated files may otherwise never be compiled. Apply required independent review when the user or repository calls for it; expose its real findings rather than claiming a review happened.
5. Validate the intended behavior in the running product. For a keyboard UI, check Tab **and Shift+Tab**, focus-specific keys, navigation in both directions, wrap/clamp behavior, empty states, Enter/Esc, modifier handling, modal priority, and preserved global shortcuts. Check source contracts that tests cannot prove, such as terminal handoff and reconnect behavior. Clearly report interactions not exercised.
6. Turn user feedback or a real missing feature into a narrow follow-up slice when appropriate. Supply the updated interfaces and context and dispatch only that slice within existing authorization; ask if it changes model, spending permission, or scope. Update wiring, help, audit, and regression tests together. Re-run affected validation after corrections.

See [the piw run lessons](references/piw-lessons.md) for concrete examples of why compile success and interaction success are separate.

## Finish

Report what was generated, what was integrated, checks actually run, remaining blockers, artifact paths, and actual usage/cost only when recorded. Distinguish model-reported claims from independently observed results. Do not claim live verification from compilation alone, or integration from a directory of staged files. Honor explicit cancellation: stop further dispatch and automatic continuation, preserve received work, and explain any requests already in flight.
