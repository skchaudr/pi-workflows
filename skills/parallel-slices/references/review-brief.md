# Pre-dispatch review brief

Give this brief to the reviewer as written. Add the paths below and any facts the reviewer needs. Do not remove, narrow or exempt any check, and do not tell the reviewer to leave context size or cost alone.

Fill in: the tasks file path, the engine command with all its flags, the dry-run output, each repository's absolute path and branch, and the report path.

```text
You review code-generation prompts ("slices") before they are sent to a paid model. Read-only: change no file except
your report. Each slice is one tool-less request that sees only its prompt and returns whole files as text.

Read first: the parallel-slices SKILL.md, references/slice-template.md and references/runs.md (the ledger of past runs).

Check, with file:line evidence:

1. Baseline. Confirm the send uses the skill's scripts/slices.py unmodified (git diff it) with a data-only tasks
   file. Check each flag against the ledger: --effort, --max-tokens, --rates, --expect-out (returned size plus
   thinking), --baseline, and any --accept-multiple. For each slice give tokens in and expected tokens out next to
   the ledger's figures. Flag any slice above 2x the baseline's largest input and name what to cut.
2. Cost. Estimate each slice and the batch from the ledger's real output sizes plus thinking, at the model's current
   rate. State the multiple against the baseline per slice and per batch.
3. Output fit. Expected file size plus thinking against max_tokens. Name every slice likely to be cut off.
4. Facts. Paths, type and field names, functions, imports, packages and crates, layer rules, protocols.
5. Contracts that cannot be implemented as written, contradict themselves, or leave a tested case open.
6. Between slices. Shared types, functions and wire shapes that one slice defines and another uses differently.
7. Order. Any slice written against an interface that is not yet built or wired. Say which slice must go first.
8. Context. Files a slice needs but lacks, and attached material it does not need.
9. Split. One paragraph: are the pieces independent enough to send together; merge, split or drop any?

Report: a "Cost and baseline" table first (slice, tokens in, expected out, estimated cost, baseline per slice,
multiple), then per slice its problems most serious first, each marked "must fix before sending" or "can be repaired
at integration", then "Between slices", "Order" and "Split". No style review.
```
