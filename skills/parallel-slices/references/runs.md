# Slice run ledger

The baseline for every new run. Read it before writing prompts; append a row after every run.

Sizes are in tokens. "In per slice" is the runner's dry-run count before 2026-11-21 and the billed count after. "Returned" is the text that came back, measured from the saved raw returns (bytes / 4); it does not include billed thinking. Before 2026-11-21 no run recorded its bill: those costs are the runner's dry-run estimates, which assumed 6k tokens out per slice and undercounted. The exact ceiling for all of them together is the OpenRouter key's November spend before 2026-11-22 UTC, **$6.95 across about 40 requests, so at most about $0.17 per slice**.

| Date (PST) | Repo · runner                                   | Model                   | Requests            | In per slice | Returned per slice       | Estimate        | Cost                               | Outcome                                              |
| ---------- | ----------------------------------------------- | ----------------------- | ------------------- | ------------ | ------------------------ | --------------- | ---------------------------------- | ---------------------------------------------------- |
| 2026-11-17 | pi-workflows · `task-scripts/piw-tui.py`        | `google/gemini-4-argon` | 12 + 1 follow-up    | about 4k     | 0.7k–5.6k, median 2.7k   | $0.74           | not recorded                       | all whole; merged as the keyboard viewer             |
| 2026-11-19 | grok-build-acpx · `task-scripts/acpx-tui.py`    | `google/gemini-4-argon` | 13 over three sends | about 7k     | 3.8k–20k, median 8.7k    | $0.67 and $0.15 | not recorded                       | all whole; integrated                                |
| 2026-11-19 | grok-build-acpx · `task-scripts/acpx-mode.py`   | `google/gemini-4-argon` | 4                   | 11k–15k      | 7.5k–22k, median 14.6k   | $0.33           | not recorded                       | all whole; integrated                                |
| 2026-11-20 | grok-build-acpx · `task-scripts/acpx-repair.py` | `google/gemini-4-argon` | 1 + 5 + 3 refire    | about 17k    | 0.4k–9.7k, median 3.4k   | $0.39 and $0.30 | not recorded                       | all whole; integrated                                |
| 2026-11-21 | grok-build-acpx · `task-scripts/piw-in-grok.py` | `google/gemini-4-neon`  | 6 + 1 resend        | 110k–206k    | 6.6k–26.5k, median 23.5k | $4.37           | **actual $8.83** ($1.47 per slice) | 3 of 6 cut off at the 64k output cap; not integrated |

Those four working runners (`acpx-repair.py` imports `acpx-mode.py`) each carried a copy of one engine, from `~/.config/nvim/templates/parallel-slices-with-context.py`, with a 32 KB per-file context cap, `max_tokens` 32k–64k and no thinking setting. Because each copy could be edited, the 2026-11-21 runner dropped the cap. From 2026-11-21 the only engine is this skill's `scripts/slices.py`, and tasks files hold data only.

## What went wrong on 2026-11-21

At least 8x the per-slice ceiling above. Each cause broke a rule in the skill:

- **New runner, no context cap.** A new copy of the engine replaced the working one and attached whole files; the 216 KB `server.ts` went into five of six prompts. Input was 933k tokens against at most 105k for any earlier batch.
- **Thinking left at the default.** Neon billed 24k–46k thinking tokens per slice as output, inside the same 64k `max_tokens` as the file, so three slices were cut off. A resend at `reasoning.effort: "low"` used 8k thinking and came back whole for $1.06 instead of $1.56.
- **Estimate guessed, never compared.** The dry run assumed 20k out per slice with no thinking and showed $4.37 without the earlier runs beside it. Actual output averaged 56k per slice.
- **Reviewer told not to look.** The review brief said "Do not suggest trimming context" and asked nothing about cost, so a 37-finding review said nothing about the largest problem.
- **Reviewed redesign skipped.** The reviewer said one slice should be dropped or its seam designed first; it was redesigned and sent without a second review.
- **Pilot dropped.** A one-slice pilot was recommended for three reasons. When the user challenged one, all three were dropped, and the two left standing (an unwired wire format, the 64k output cap) were the ones that failed.
