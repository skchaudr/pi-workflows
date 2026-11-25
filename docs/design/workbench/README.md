# Workbench prototype

`index.html` is a design prototype for a workflow workbench shown beside `grok acpx` with
`terminal-browser`. Open it with:

```bash
terminal-browser open docs/design/workbench/index.html --split right
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
  has one in the right-hand column. They are stored in the browser's local storage, and
  `workbench.state().notes` returns them.
- **Generated file.** The draft writes a `.workflow.ts`: a shell check routed by
  `$result.outcome`, a `settingsRoute` guard counting repairs in `state.steps`, an agent repair,
  and a `humanDecision` gate.
- **Verified so far:** with the limits filled in, the generated file typechecks against this
  repository and loads through `defineWorkflow`.

## Not built

- **Live mode** is not connected to `piw serve`.
- **Comments** are not saved anywhere outside the browser.
- **Replay data** is built into the page from run `8814563d`; the page does not read the state
  database.
- **Template approach:** not decided yet. The page has one hard-coded draft,
  `check-repair-review`, and no library.
