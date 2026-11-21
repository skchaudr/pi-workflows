# The ACP harness adapter: what the two codebases already agree on

Date: 2026-11-16. Status: exploration note, not a design or a commitment.

## The finding

`WorkflowEngine` takes any `AgentStepExecutor`, and `AcpRuntime` is already that
interface. The mapping is one-to-one, and it was not coordinated:

| Workflow step needs    | `AcpRuntimeTurnInput` / `AcpRuntimeTurn` provides                            |
| ---------------------- | ---------------------------------------------------------------------------- |
| durable identity       | `requestId: string`                                                          |
| engine-resolved budget | `timeoutMs?: number`                                                         |
| cooperative stop       | `cancel()`, driven by the caller's `AbortSignal`                             |
| dispatch admission     | `promptStarted` (transport accepted the prompt)                              |
| live evidence          | `events`: `text_delta`, `status` (`usage`, `plan`, `tool_call`), `tool_call` |
| settled outcome        | `result`: `completed` \| `cancelled` \| `failed`                             |

The four engine outcomes (`ok`, `failed`, `timed_out`, `cancelled`) and the three
runtime results line up directly, so `$result.outcome` routing works on a
non-Pi node without translation.

Capability injection is also already public. `AcpRuntimeOptions.mcpServers`
takes a resolver per session, and `AcpClient` registers client-side request
handlers and sends `clientCapabilities`. A step-submit tool reaches any
harness that accepts MCP; `elicitationModes` covers harnesses that do not.

## Why it matters

`acpx` becomes the transport that turns another harness into a _node in the
graph_ rather than a subprocess. Claude, Droid, Codex, DSH and the rest run in
their own hardened harnesses, but under Pi's step contract: durable request id,
engine deadline, validated submitted output, retry safety from the engine's
effect key, and records in the same run and the same viewer.

Uncertain outcomes also already agree. An ambiguous external result parks for
explicit operator recovery in both systems, and neither retries automatically.
That shared rule is what makes a cross-harness step safe to add.

## What still has to be built

An adapter that implements `AgentStepExecutor` by calling `createAcpRuntime`
and `startTurn`. It uses acpx as a library, not as a CLI. Harnesses that accept
neither MCP nor elicitation fall back to supervised structured output, which is
a capability fact to discover per harness, not a gap in the design.

## Provenance

Everything above is readable in current published source. pi-workflows: the
`WorkflowEngine` and `AgentStepExecutor` section of `docs/WORKFLOWS.md`, plus
`src/workflows/index.ts`. acpx: `src/runtime/public/contract.ts` and
`src/acp/client.ts` at `openclaw/acpx`. Both MIT, no upstream change required.
