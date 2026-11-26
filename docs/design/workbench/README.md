# Workflow design docs

A workflow's design doc is one HTML page kept beside the workflow: `<name>.design.html` next to
`<name>.workflow.ts`. The first one is grok-build `.pi/workflows/beta8-repair.design.html`. It is a
design prototype for a workflow workbench shown beside `grok acpx` with `terminal-browser`.

`serve.mjs` serves the doc and saves the comments typed into it. Start it with the workflow file,
then open the address it prints:

```bash
node docs/design/workbench/serve.mjs ~/repos/grok-build/.pi/workflows/beta8-repair.workflow.ts
```

```bash
terminal-browser open http://127.0.0.1:7717/ --split right
```

## The approach so far

- **piw's visual language.** One graph of piw cards: the step id in the header, a type badge
  (`●` agent, `ƒ` compute, `$` shell, `◆` gate), `↻` attempts, `◷` elapsed and limit, then a
  one-line description of what the step does.
- **Three modes on the same graph.**
  - `1` replay reads a past run.
  - `2` draft edits the workflow for the next run.
  - `3` live changes a run in progress.
- **Limits are part of the card.** In the draft, a card with a missing limit has a dashed red
  border, and the key line lists what's missing. Saving is blocked until every limit is set.
- **Gates are answered with keys** (`1`, `2`, `3`), never with free text.
- **Comments.** Every card has an open comment box under it, and every phase (a group of rows)
  has one in the right-hand column. They are kept in the doc itself, in its
  `<script type="application/json" id="notes">` block, keyed by graph title and then step or
  phase id. Typing saves to the file. Leaving the box commits the doc in the workflow's repository
  and pushes it; the top bar shows the commit, or in red that the comment was not saved. Opened as
  a file, without `serve.mjs`, the boxes are read-only.
- **Workflow file.** `s` shows the `.workflow.ts` beside the doc, read through `serve.mjs`.

## Not built

- **Live mode** is not connected to `piw serve`.
- **Replay data** is built into the page from run `8814563d`; the page does not read the state
  database.
- **Template approach:** not decided yet. The graph in the doc is written by hand to match the
  workflow file; editing limits in the page does not change the file.
- **`serve.mjs` is not started for you.** Comments are saved only while it runs.
