import path from "node:path";
import { CancelledError } from "../workflows/errors.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import { AcpxStepExecutor, type AcpxStepExecutorOptions } from "./acpx-executor.js";

/** Where a run keeps the acpx session records of its steps: inside the server's state, per run. */
export function acpxRunStateDir(serverStateDirectory: string, runId: string): string {
  return path.join(serverStateDirectory, "acpx", runId);
}

/** Builds the executor for one step that names an agent. */
export type AcpxExecutorFactory = (agent: string, model: string | undefined) => AgentStepExecutor;

/** An acpx executor whose cwd, state folder and process registry come from the run. */
export function acpxExecutorFactory(
  shared: Omit<AcpxStepExecutorOptions, "agent" | "model">,
): AcpxExecutorFactory {
  return (agent, model) =>
    new AcpxStepExecutor({ ...shared, agent, ...(model === undefined ? {} : { model }) });
}

/**
 * Sends a step that names an `agent` to an acpx executor and every other step to the run's own
 * executor, untouched. The capability flags are the run's own executor's: they describe the steps
 * without an agent, which are the only steps that reach it. A step with an agent never has
 * assistant-message completion; workflow validation refuses it and this executor refuses it again
 * for a definition built some other way. The acpx executor enforces an agent step's allowlist.
 *
 * `close()` cancels every running acpx step, which cancels its turn and leaves no agent process,
 * so a runner that is told to stop can end a run in the middle of an acpx step.
 */
export class AgentRoutingExecutor implements AgentStepExecutor {
  private readonly shutdown = new AbortController();
  private readonly running = new Set<Promise<unknown>>();

  readonly assistantMessageMode?: "visible" | "park" | "unsupported";
  readonly preservesActiveTimeBudget?: boolean;
  readonly enforcesToolAllowlist?: boolean;

  constructor(
    private readonly runExecutor: AgentStepExecutor,
    private readonly acpx: AcpxExecutorFactory,
  ) {
    const { assistantMessageMode, preservesActiveTimeBudget, enforcesToolAllowlist } = runExecutor;
    if (assistantMessageMode !== undefined) this.assistantMessageMode = assistantMessageMode;
    if (preservesActiveTimeBudget !== undefined) {
      this.preservesActiveTimeBudget = preservesActiveTimeBudget;
    }
    if (enforcesToolAllowlist !== undefined) this.enforcesToolAllowlist = enforcesToolAllowlist;
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    if (request.agent === undefined) return await this.runExecutor.runAgentStep(request, signal);
    refuseUnsupported(request, request.agent);
    const step = this.acpx(request.agent, request.model).runAgentStep(
      request,
      AbortSignal.any([signal, this.shutdown.signal]),
    );
    this.running.add(step);
    try {
      return await step;
    } finally {
      this.running.delete(step);
    }
  }

  /** Cancel running acpx steps and wait until each has torn its agent down. */
  async close(): Promise<void> {
    this.shutdown.abort(new CancelledError("Workflow runner is shutting down"));
    await Promise.allSettled(this.running);
  }
}

function refuseUnsupported(request: AgentStepRequest, agent: string): void {
  if (request.contract.completion !== "assistant") return;
  throw new Error(
    `Workflow step ${JSON.stringify(request.contract.nodeId)} sets agent ${JSON.stringify(agent)}, which does not support assistantMessage() completion`,
  );
}
