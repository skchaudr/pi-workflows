import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AcpProcessLifecycle,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "acpx/runtime";
import type { StepActivityBody } from "../state/step-activity.js";
import { CancelledError, errorMessage } from "../workflows/errors.js";
import { isHarnessControlledAgent, type HarnessControlledAgent } from "../workflows/schema.js";
import {
  parseWorkflowSubmissionInput,
  WorkflowSubmissionToolParameters,
  type WorkflowSubmissionInput,
} from "../workflows/tool-input.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import {
  SubmissionChannel,
  type ChannelAnswer,
  type ChannelCall,
} from "./acpx-submission-channel.js";
import { MAX_SUBMISSION_REMINDERS } from "./recovery.js";
import type { SupervisedProcessRegistry } from "./rpc-executor.js";
import { stepActivityFromAcpx } from "./step-activity.js";

// Production resolves the compiled .js; tests and dev checkouts run the .ts source, which node
// type-strips (the script imports nothing from the package).
const MCP_SCRIPT_PATH = ["./acpx-submit-mcp.js", "./acpx-submit-mcp.ts"]
  .map((candidate) => fileURLToPath(new URL(candidate, import.meta.url)))
  .find((candidate) => fs.existsSync(candidate));
const DEFAULT_ABORT_GRACE_MS = 3_000;

/** A stdio MCP server as acpx's runtime takes it (the ACP stdio shape). */
export type AcpxMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

export type AcpxRuntimeFactoryInput = {
  cwd: string;
  stateDir: string;
  mcpServers: AcpxMcpServer[];
  processLifecycle: AcpProcessLifecycle;
};

/** The part of acpx's runtime a step uses; tests inject a fake. */
export interface AcpxStepRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  setModel(input: { handle: AcpRuntimeHandle; model: string }): Promise<void>;
  setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void>;
  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn;
  shutdown(): Promise<void>;
}

export type AcpxRuntimeFactory = (
  input: AcpxRuntimeFactoryInput,
) => AcpxStepRuntime | Promise<AcpxStepRuntime>;

export type AcpxStepExecutorOptions = {
  cwd: string;
  /** An acpx agent name; steps run only on one of `HARNESS_CONTROLLED_AGENTS`. */
  agent: string;
  /** Applied with `setModel` when present; otherwise the agent's default model runs. */
  model?: string;
  /** Where acpx keeps its session records. Not the user's own acpx state. */
  stateDir: string;
  /** How long cancel and shutdown may take before leftover agent processes get SIGKILL. */
  abortGraceMs?: number;
  /**
   * Told about every agent process the step starts and ends, so a server can reap a process whose
   * runner died before it could.
   */
  registry?: SupervisedProcessRegistry;
  runtimeFactory?: AcpxRuntimeFactory;
};

/** The real acpx runtime; the default for `runtimeFactory`. Exported so a live check can wrap it. */
export async function createAcpxRuntime(input: AcpxRuntimeFactoryInput): Promise<AcpxStepRuntime> {
  const acpx = await import("acpx/runtime");
  await fs.promises.mkdir(input.stateDir, { recursive: true });
  return acpx.createAcpRuntime({
    cwd: input.cwd,
    sessionStore: acpx.createFileSessionStore({ stateDir: input.stateDir }),
    agentRegistry: acpx.createAgentRegistry(),
    // The step's allowed tools never ask (they are in the session's allowedTools). Anything else
    // reaches acpx as a permission request, and a headless step has nobody to answer it: deny.
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    mcpServers: input.mcpServers,
    processLifecycle: input.processLifecycle,
  });
}

/**
 * How a step sets each agent's harness instead of inheriting the machine's interactive settings.
 * `mode` is applied with `setMode` after the session opens: Claude otherwise starts in the user's
 * `defaultMode` (for example bypassPermissions), which skips permission checks entirely.
 * `workflowTool` is the name the agent gives the MCP `workflow` tool, added to every allowlist.
 */
const HARNESS: Record<HarnessControlledAgent, { mode: string; workflowTool: string }> = {
  claude: { mode: "default", workflowTool: "mcp__workflow__workflow" },
};

/**
 * Runs agent steps through acpx, so a step can run on another agent such as Claude. One
 * oneshot session serves one step attempt. The model hands its result in through an MCP tool named
 * `workflow` with the same input as the Pi `workflow` tool (`submit` and `update`); the tool
 * forwards each call over a private channel to this executor, which validates through
 * `request.accept` and answers the model. A rejected submission comes back to the model as the tool
 * result, so it corrects and submits again.
 *
 * Like the Pi executor, a step resolves as soon as its submission is accepted. Unlike Pi, the
 * session belongs to the step, so the rest of the turn is cancelled and the agent is shut down
 * before the step resolves.
 *
 * Every step states its harness: the session gets the step's `allowedTools` plus the workflow
 * tool, the agent is put in an explicit permission mode, and acpx denies every other permission
 * request. A step without `allowedTools`, or on an agent pi-workflows cannot set up, is refused.
 * Assistant-message completion needs an origin Pi session, so `assistantMessageMode` is
 * "unsupported".
 */
export class AcpxStepExecutor implements AgentStepExecutor {
  readonly assistantMessageMode = "unsupported" as const;
  readonly enforcesToolAllowlist = true;

  constructor(private readonly options: AcpxStepExecutorOptions) {}

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    throwIfAborted(signal);
    const { nodeId, allowedTools } = request.contract;
    const agent = this.options.agent;
    if (!isHarnessControlledAgent(agent)) {
      throw new Error(
        `Workflow step ${JSON.stringify(nodeId)} sets agent ${JSON.stringify(agent)}, whose permission mode and tools pi-workflows cannot set`,
      );
    }
    if (allowedTools === undefined) {
      throw new Error(
        `Workflow step ${JSON.stringify(nodeId)} sets agent ${JSON.stringify(agent)} without allowedTools`,
      );
    }
    const harness = HARNESS[agent];
    const tools = [...allowedTools, harness.workflowTool];
    return await new AcpxStep(this.options, request, signal, { mode: harness.mode, tools }).run();
  }
}

class AcpxStep {
  private readonly graceMs: number;
  private readonly agentPids = new Set<number>();
  private registrations: Promise<unknown> = Promise.resolve();
  private accepted: { value: unknown } | undefined;
  private failure: unknown;
  private settle: () => void = () => undefined;
  private readonly settled = new Promise<void>((resolve) => (this.settle = resolve));
  private runtime: AcpxStepRuntime | undefined;
  private turn: AcpRuntimeTurn | undefined;
  private turnCount = 0;
  private closed = false;

  constructor(
    private readonly options: AcpxStepExecutorOptions,
    private readonly request: AgentStepRequest,
    private readonly signal: AbortSignal,
    private readonly harness: { mode: string; tools: string[] },
  ) {
    this.graceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  }

  async run(): Promise<AgentStepSubmission> {
    if (MCP_SCRIPT_PATH === undefined) {
      throw new Error("The pi-workflows acpx submission script is missing from this installation");
    }
    const channel = await SubmissionChannel.open((call) => this.handleCall(call));
    const abort = this.watchAbort();
    try {
      const driving = this.drive(MCP_SCRIPT_PATH, channel);
      // If the abort wins the race, the cancelled drive settles later with nobody listening.
      driving.catch(() => undefined);
      return await Promise.race([driving, abort.promise]);
    } finally {
      abort.stop();
      await this.teardown(channel);
    }
  }

  private async drive(
    scriptPath: string,
    channel: SubmissionChannel,
  ): Promise<AgentStepSubmission> {
    const runtime = await this.openRuntime(scriptPath, channel);
    this.assertOpen();
    const handle = await runtime.ensureSession({
      sessionKey: `workflow-step-${this.request.contract.attemptId}`,
      agent: this.options.agent,
      mode: "oneshot",
      cwd: this.options.cwd,
      sessionOptions: { allowedTools: this.harness.tools },
    });
    await runtime.setMode({ handle, mode: this.harness.mode });
    if (this.options.model !== undefined) {
      await runtime.setModel({ handle, model: this.options.model });
    }
    let text = `${this.request.prompt}\n\n${TOOL_NOTE}`;
    for (let reminders = 0; ; reminders++) {
      this.assertOpen();
      const submitted = await this.runTurn(runtime, handle, text);
      if (submitted !== undefined) return { output: submitted.value };
      if (reminders >= MAX_SUBMISSION_REMINDERS) throw this.missingSubmission();
      text = reminderPrompt(this.request);
    }
  }

  private async openRuntime(
    scriptPath: string,
    channel: SubmissionChannel,
  ): Promise<AcpxStepRuntime> {
    const factory = this.options.runtimeFactory ?? createAcpxRuntime;
    const runtime = await factory({
      cwd: this.options.cwd,
      stateDir: this.options.stateDir,
      mcpServers: [
        {
          name: "workflow",
          command: process.execPath,
          args: [scriptPath],
          env: Object.entries(channel.env(WorkflowSubmissionToolParameters)).map(
            ([name, value]) => ({ name, value }),
          ),
        },
      ],
      processLifecycle: {
        onSpawned: (started) => {
          this.agentPids.add(started.pid);
          this.tellRegistry("register", started.pid);
        },
        onExit: (exit) => {
          this.agentPids.delete(exit.pid);
          this.tellRegistry("unregister", exit.pid);
        },
      },
    });
    this.runtime = runtime;
    return runtime;
  }

  /** Registry calls run one after another; a failed one fails the step, as it does for the Pi executor. */
  private tellRegistry(operation: "register" | "unregister", pid: number): void {
    const registry = this.options.registry;
    if (registry === undefined) return;
    this.registrations = this.registrations
      .then(() => registry[operation](pid))
      .catch((error: unknown) => {
        if (operation === "unregister") return;
        this.failure ??= error;
        this.settle();
      });
  }

  /** Run one turn; resolves with the accepted submission, or undefined when the turn ended without one. */
  private async runTurn(
    runtime: AcpxStepRuntime,
    handle: AcpRuntimeHandle,
    text: string,
  ): Promise<{ value: unknown } | undefined> {
    const turn = runtime.startTurn({
      handle,
      text,
      mode: "prompt",
      requestId: `${this.request.contract.attemptId}:${++this.turnCount}`,
    });
    this.turn = turn;
    const finished = finishTurn(turn, this.request.onActivity, () => this.reportingLive());
    finished.catch(() => undefined);
    const outcome = await Promise.race([finished, this.settled]);
    if (this.failure !== undefined) throw this.failure;
    if (this.accepted !== undefined) {
      await this.cancelTurn("workflow step accepted");
      return this.accepted;
    }
    this.throwIfTurnBroke(outcome as AcpRuntimeTurnResult);
    return undefined;
  }

  /**
   * Activity is reported only while the step is still running. Once a submission is accepted, the
   * accept throws, or the step aborts, this executor cancels the acpx turn itself, and the runtime
   * then marks any tool call that was still open as rejected ("the user doesn't want to proceed").
   * Those are teardown artifacts of a call that did not fail, so they must not reach watchers. A
   * tool call that really fails while the step is live is still reported.
   */
  private reportingLive(): boolean {
    return this.accepted === undefined && this.failure === undefined && !this.signal.aborted;
  }

  private throwIfTurnBroke(result: AcpRuntimeTurnResult): void {
    if (result.status === "failed") throw new Error(result.error.message);
    if (result.status === "cancelled") {
      throw new Error(
        `The acpx turn for step ${JSON.stringify(this.request.contract.nodeId)} was cancelled`,
      );
    }
  }

  private missingSubmission(): Error {
    const { nodeId, requestId } = this.request.contract;
    return new Error(
      `Workflow step ${JSON.stringify(nodeId)} (requestId ${requestId}) ended without a submission from agent ${this.options.agent} after ${MAX_SUBMISSION_REMINDERS} reminders`,
    );
  }

  private async handleCall(call: ChannelCall): Promise<ChannelAnswer> {
    const input = parseWorkflowSubmissionInput(call.arguments);
    const { requestId, attemptId } = this.request.contract;
    if (input.requestId !== requestId) {
      return {
        ok: false,
        text: `requestId ${JSON.stringify(input.requestId)} does not belong to this step. The pending requestId is ${JSON.stringify(requestId)}.`,
      };
    }
    if (this.accepted !== undefined) {
      return {
        ok: false,
        text: "This step already has an accepted submission; do not call the workflow tool again.",
      };
    }
    return input.action === "submit"
      ? await this.submit(input.output)
      : await this.update(input, `acpx:${attemptId}:${String(call.callId)}`);
  }

  private async submit(output: unknown): Promise<ChannelAnswer> {
    let result: Awaited<ReturnType<AgentStepRequest["accept"]>>;
    try {
      result = await this.request.accept(output);
    } catch (error) {
      // A throwing accept is a server failure, not a model mistake: it fails the step.
      this.failure = error;
      this.settle();
      return { ok: false, text: "The workflow server failed while checking the submission." };
    }
    if (!result.ok) {
      return {
        ok: false,
        text: [
          `The workflow rejected your submission for step ${JSON.stringify(this.request.contract.nodeId)}:`,
          result.error,
          "",
          "Call the `workflow` tool again with a corrected output.",
        ].join("\n"),
      };
    }
    this.accepted = { value: result.value };
    this.settle();
    return {
      ok: true,
      text: "Submission accepted. This step is complete; do not call the workflow tool again.",
    };
  }

  private async update(
    input: Extract<WorkflowSubmissionInput, { action: "update" }>,
    idempotencyKey: string,
  ): Promise<ChannelAnswer> {
    if (this.request.publishUpdate === undefined) {
      return { ok: false, text: "This workflow server does not support step updates." };
    }
    try {
      await this.request.publishUpdate(input.update, idempotencyKey);
      return { ok: true, text: "Workflow update recorded; continue the current step." };
    } catch (error) {
      return {
        ok: false,
        text: `Workflow update rejected: ${errorMessage(error)}. Correct the update and continue the same step.`,
      };
    }
  }

  private watchAbort(): { promise: Promise<never>; stop: () => void } {
    let onAbort: () => void = () => undefined;
    const promise = new Promise<never>((_, reject) => {
      onAbort = () => {
        void this.cancelTurn("workflow step aborted");
        reject(abortReason(this.signal));
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    promise.catch(() => undefined);
    return { promise, stop: () => this.signal.removeEventListener("abort", onAbort) };
  }

  private async cancelTurn(reason: string): Promise<void> {
    const turn = this.turn;
    if (turn === undefined) return;
    await settleWithin(
      turn.cancel({ reason }).then(() => turn.result),
      this.graceMs,
    );
  }

  private assertOpen(): void {
    if (this.closed) throw abortReason(this.signal);
  }

  /** Shut the runtime down, then make sure no agent process is left, then drop the private channel. */
  private async teardown(channel: SubmissionChannel): Promise<void> {
    this.closed = true;
    try {
      if (this.runtime !== undefined) await settleWithin(this.runtime.shutdown(), this.graceMs);
      await this.reapAgents();
      await this.registrations;
    } finally {
      await channel.close();
    }
  }

  private async reapAgents(): Promise<void> {
    const deadline = Date.now() + this.graceMs;
    while (this.agentPids.size > 0 && Date.now() < deadline) await sleep(25);
    for (const pid of this.agentPids) {
      killQuietly(pid);
      this.tellRegistry("unregister", pid);
    }
    this.agentPids.clear();
  }
}

const TOOL_NOTE =
  'The `workflow` tool named above is served by the MCP server "workflow". Your client may list it as workflow__workflow or mcp__workflow__workflow; call that tool, not any built-in tool with a similar name.';

function reminderPrompt(request: AgentStepRequest): string {
  const { requestId, nodeId, expectedOutput } = request.contract;
  return [
    `The workflow step ${JSON.stringify(nodeId)} has not received your submission yet.`,
    "Call the `workflow` tool now with exactly:",
    `{"action": "submit", "requestId": ${JSON.stringify(requestId)}, "output": <your result>}`,
    `Expected output: ${typeof expectedOutput === "string" ? expectedOutput : "a JSON object with your result"}`,
    TOOL_NOTE,
  ].join("\n");
}

/**
 * Drain a turn's events, mapping the visible ones to `onActivity` while the step is live, then
 * return its canonical result. Events after the step resolved belong to the turn cancellation,
 * not the agent: the runtime marks calls the executor interrupted as rejected tool calls.
 */
async function finishTurn(
  turn: AcpRuntimeTurn,
  onActivity: ((body: StepActivityBody) => void) | undefined,
  isStepLive: () => boolean,
): Promise<AcpRuntimeTurnResult> {
  try {
    for await (const event of turn.events) {
      if (isStepLive()) reportTurnEvent(onActivity, event);
    }
  } catch {
    // The turn result below is the canonical outcome.
  }
  return await turn.result;
}

/** Live activity must never fail a step, whatever the callback does. */
function reportTurnEvent(
  onActivity: ((body: StepActivityBody) => void) | undefined,
  event: AcpRuntimeEvent,
): void {
  if (onActivity === undefined) return;
  try {
    const body = stepActivityFromAcpx(event);
    if (body !== undefined) onActivity(body);
  } catch {
    // Activity is best-effort reporting.
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (signal.reason as unknown) ?? new CancelledError("Workflow step aborted");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a promise, but never longer than `ms`; its failure is not the caller's concern. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
  ]);
  clearTimeout(timer);
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
