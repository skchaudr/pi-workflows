# Slice assignment template

Replace the placeholders with facts from the repository. This is a prompt template, not an executable workflow or permission to dispatch. Keep shared declarations identical across slices.

```text
Slice id: <stable unique id>
Target file: <one repository-relative path>
Goal: <concrete behavior this file provides>

Ownership:
Return this complete file only. Do not modify other files, add dependencies,
or redefine the existing types below. The coordinator owns <specific wiring>.

Environment:
<language/compiler version, dependency versions, repository rules>

Existing interfaces:
<exact declarations, derives, visibility, and import paths>
<state, protocol, coordinate, or event semantics the implementation relies on>

Public surface the coordinator will call:
<exact types, fields, function signatures, ownership/lifetimes, return values>

Behavior:
<deterministic rules, defaults, ordering, ties, empty/unknown inputs, errors>
<what existing behavior is replaced and what must remain unchanged>

Tests:
<named observable cases, including negative and boundary cases>
<tests must not need real network calls, user files, or an interactive terminal>

Return format:
<complete source in one named-language fence, or a raw Markdown document>
No omitted implementations, pseudocode, or extra files.
```

Attach complete relevant source excerpts after or before this assignment with their repository-relative paths. Label elided bodies explicitly. The worker sees only the supplied prompt, not the coordinator's tools, conversation, repository, or sibling returns.

## Coordinator's preflight

- Can the worker implement every public function from this information alone?
- Do all attached files exist and all required declarations fit in the actual request?
- Is the target unique, confined to the intended repository, and staged outside production source?
- Are public types imported rather than copied into competing modules?
- Are test fixtures constructible with the provided fields and derives?
- Have all consumers received the same shared contract and key/protocol changes?
- Does the request use the chosen provider/model, without tools or autonomous execution?

Do not make low-risk generation wait on hypothetical integration issues. Fix demonstrated prompt contradictions before dispatch; handle ordinary adapter code and mechanical repairs during integration.
