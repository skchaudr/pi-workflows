# Lessons from the piw keyboard UI run

The operator repeated an earlier text-only TypeScript generation method for the Rust piw viewer. Independent requests produced complete files from focused context and fixed public interfaces. A coordinating agent compiled, corrected, and wired the results. The method does not depend on Claude or a particular generation model.

The Rust run used `google/gemini-4-argon` through OpenRouter, an intentional operator choice. A previous Flash run's reported low cost was not evidence that Argon was the wrong model, that the models had equivalent quality, or that this run would cost the same.

Source-checkout evidence (not dependencies required to install this skill):

- `task-scripts/piw-tui.py`: slice contracts, context injection, dry run, selective dispatch, staged files, and raw returns.
- Commit `1b55c91`: the initial eleven generated outputs. Later work added a node-details popup slice; do not hardcode the batch count.
- Commit `a67b1ca`: generated node-details popup plus integration corrections, including reverse focus with Shift+Tab and graph key hints.
- Commit `d9e1f75`: corrected Space back to global play/pause; only Enter opens the node popup.
- Merge `03e1df8`: the integrated keyboard-first viewer work.

## What transfers to another task

- Independent file ownership plus explicit interfaces made useful parallel generation possible without workers touching a shared worktree.
- The geometry-only graph navigation slice needed only the real `NodeBounds` declaration and coordinate semantics, not the whole viewer.
- Help and an independently generated keyboard audit needed the same reserved navigation keys. Isolated context is useful only when shared facts stay consistent.
- `select_graph_node` initially selected a historical executed step, not an arbitrary graph node. A helper's name was not enough to establish its semantics; keyboard focus and replay selection needed deliberate integration.
- The coordinator reported compilation after one typo correction, but later hands-on use still found missing reverse focus. Test Tab and Shift+Tab, not merely the presence of a key handler.
- A popup addition briefly assigned Space a second role that conflicted with global playback. Exercise shortcut precedence across focus and modal states, not only isolated module tests.
- A newly discovered gap can be another focused generation request. Preserve accepted modules and revise the relevant contract, wiring, documentation, and regression coverage rather than restarting the batch.

These are execution lessons, not proof that all current viewer behavior is verified or that a particular cost or code volume will recur.
