# Grok workflow archive — 2026-11-17

Historical source, not installed workflows, not a reusable-library endorsement.
This directory is outside `.pi/workflows` and `~/.pi/agent/workflows`, so normal
workflow discovery does not offer these archived definitions. Do not launch them
from this archive without a new operator-agreed design and execution authority.
Original paths and bytes are recorded in `manifest.json`.

## Inventory

11 created definitions:

- `.pi/workflows/landing.workflow.ts`
- `.pi/workflows/prepare-landing.workflow.ts`
- `.pi/workflows/reviewed-task.workflow.ts`
- `.pi/workflows/acceptance-checks.workflow.ts`
- `.pi/workflows/launch-landing.workflow.ts`
- `.pi/workflows/integrate-landing.workflow.ts`
- `.pi/workflows/lib/independent-review.workflow.ts`
- `.pi/workflows/lib/visible-command.workflow.ts`
- `.pi/workflows/lib/task-run.workflow.ts`
- `.pi/workflows/handoff-kickoff.workflow.ts`
- `.pi/workflows/establish-kickoff.workflow.ts`

One existing definition modified: `.pi/workflows/step.workflow.ts`. Its modified
version is archived here; Grok's active copy was restored to its pre-session HEAD
version. Supporting helpers, nine test files, launcher, input example, READMEs,
review disposition and kickoff prompt accompany the definitions. Role/policy
files and Grok AGENTS.md are context snapshots, not instructions for this fork;
the active role/policy edits remain in Grok and are not discarded by this move.
The archived kickoff prompt is not installed. Several paths/cwd assumptions
remain Grok-specific; moving the files does not port them to this repository.
Older READMEs describe earlier states and are preserved verbatim, not current
status. Existing Grok workflow run records were not moved, reset or deleted.

## What actually happened

- Landing run `20261115T021043931Z-landing-9197de92` reached its preparation gate.
  Investigation showed that the proposed execution was unnecessary; product
  landing occurred outside that workflow. The operator cancelled the run. The
  gate yielding a useful decision is a positive outcome, not proof of useless
  workflow machinery. No automatic restart is authorized.
- Establishment run `20261116T201927321Z-establish-kickoff-256b7366` accepted
  inspection and implementation, dispatched one independent reviewer, then
  failed for missing step submission after two reminders. piw shows implementation
  as the last recorded completed step and review queued. This exposed a mismatch
  between an immediate agent-result obligation and asynchronous child completion.
- Reviewer `c43294ff-3e56-4494-8898-0ab2d1d7334c` subsequently completed using
  recorded `deepseek/deepseek-flash`, thinking high; parent closed it. Report and
  disposition are referenced in `kickoff-review-disposition.md`.
- A correction pass outside the failed run separated immediate dispatch receipt,
  ordinary checkpoint wait and result collection; repaired decision display
  capacity and rejected reviewer configuration mismatches. These later changes
  were not covered by a second independent review or a real kickoff run.
- Seven focused checks passed before archival, including an isolated actual-engine
  dispatch/wait/resume fixture, channel-normalizer fixtures and artifact/model
  guards. Earlier 68 offline authoring checks cover older landing revisions.
  Neither count demonstrates the real end-to-end task. No delivery workflow
  completed an execution run, and this archive makes no broad quality verdict.

## Reflection agreed with the operator

This session says more about the collaboration, authority, communication and
runtime integration around workflows than it establishes about the quality of
all the authored definitions. The first gate helped discover that execution was
not needed. Creation count is neither progress nor a quality measure.

The coordinator selected a workflow to establish another workflow, aiming to
operationalize role/delivery lessons and demonstrate controlled execution. It did
not keep the operator oriented to that choice. Attention went to roles, policy,
validators and local tests while the basic asynchronous completion boundary was
overlooked. After failure, the coordinator repaired code outside the run rather
than first inspecting it together with the operator. Explanations and self-labels
then displaced the operator's attempt to understand the run in piw.

Future work must start with an understandable, jointly chosen program and real
task evidence. Discuss consequential governing changes; do not silently redefine
acceptance for a green result. Use piw for shared orientation, not only status
warnings. Do not turn this archive into a speculative framework or automatically
salvage it. The operator proposed this fork as the place to store workflows;
this archival move does not itself create a central installation system.

## Provenance

Source: `/Volumes/Mini-SSD/offload/repos/grok-build`.
Historical authoring commits: `61c3403a`, `2afb009b`, `21664226`, `2a0d5798`,
`7637f7cb`. Archive includes later uncommitted corrections, not just those commits.
Raw run/reviewer records remain in the existing workflow/session stores so piw
history remains available. No product builds, installs, workflow launches, pushes
or engine changes are part of this archival operation.
