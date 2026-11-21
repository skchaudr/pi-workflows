import fs from "node:fs";
import path from "node:path";
import type {
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";
import type { AcpxRuntimeFactoryInput, AcpxStepRuntime } from "../src/server/acpx-executor.js";
import {
  AgentRoutingExecutor,
  acpxExecutorFactory,
  acpxRunStateDir,
} from "../src/server/agent-routing-executor.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import {
  agent,
  assistantMessage,
  compute,
  defineWorkflow,
  includeWorkflow,
} from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { CancelledError, RunParkedError, isAbortLikeError } from "../src/workflows/errors.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../src/workflows/types.js";
import { makeStateDatabasePath, makeTempDir, waitUntil } from "./helpers.js";

const prompt = () => "Do it";

function nodeError(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the definition to be rejected");
}

function oneStep(step: unknown) {
  return () =>
    defineWorkflow({
      name: "routing-validation",
      startAt: "review",
      nodes: { review: step as ReturnType<typeof agent> },
      edges: [],
    });
}

describe("agent and model on a step: validation", () => {
  it("accepts an acpx agent with and without a model", () => {
    expect(() => oneStep(agent({ prompt, agent: "grok-build" }))()).not.toThrow();
    expect(() => oneStep(agent({ prompt, agent: "claude", model: "sonnet" }))()).not.toThrow();
  });

  it("rejects agent pi and says to omit agent for Pi steps", () => {
    const message = nodeError(oneStep(agent({ prompt, agent: "pi" })));
    expect(message).toContain("node review");
    expect(message).toContain('agent "pi"');
    expect(message).toContain("omit agent for Pi steps");
  });

  it("rejects model without agent and says model needs agent", () => {
    const message = nodeError(oneStep(agent({ prompt, model: "gpt-5.6-luna" })));
    expect(message).toContain("node review");
    expect(message).toContain("model needs agent");
  });

  it.each([{ agent: "" }, { agent: "  " }, { agent: 3 }])(
    "rejects an empty or non-string agent: %j",
    (fields) => {
      expect(nodeError(oneStep(agent({ prompt, ...fields } as never)))).toContain(
        "agent must be a nonempty acpx agent name",
      );
    },
  );

  it.each([{ model: "" }, { model: 4 }])("rejects an empty or non-string model: %j", (fields) => {
    expect(nodeError(oneStep(agent({ prompt, agent: "claude", ...fields } as never)))).toContain(
      "model must be a nonempty model id",
    );
  });

  it("rejects agent with allowedTools, naming the step and the feature", () => {
    const message = nodeError(oneStep(agent({ prompt, agent: "claude", allowedTools: ["read"] })));
    expect(message).toContain("node review");
    expect(message).toContain("does not support allowedTools");
  });

  it("rejects agent with assistantMessage(), naming the step and the feature", () => {
    const message = nodeError(
      oneStep(agent({ prompt, agent: "claude", expectedOutput: assistantMessage() })),
    );
    expect(message).toContain("node review");
    expect(message).toContain("does not support assistantMessage() completion");
  });

  it("leaves allowedTools and assistantMessage() valid on steps without an agent", () => {
    expect(() => oneStep(agent({ prompt, allowedTools: ["read"] }))()).not.toThrow();
    expect(() => oneStep(agent({ prompt, expectedOutput: assistantMessage() }))()).not.toThrow();
  });
});

describe("agent and model on a step: reach the engine request, child graphs and snapshots", () => {
  class Recorder implements AgentStepExecutor {
    readonly requests: AgentStepRequest[] = [];
    async runAgentStep(request: AgentStepRequest): Promise<AgentStepSubmission> {
      this.requests.push(request);
      return { output: { ok: true } };
    }
  }

  it("passes agent and model on the request, and nothing for a step without them", async () => {
    const recorder = new Recorder();
    const workflow = defineWorkflow({
      name: "request-fields",
      startAt: "plain",
      nodes: {
        plain: agent({ prompt }),
        grok: agent({ prompt, agent: "grok-build" }),
        claude: agent({ prompt, agent: "claude", model: "sonnet" }),
      },
      edges: [
        { from: "plain", to: "grok" },
        { from: "grok", to: "claude" },
      ],
    });
    const { state } = await new WorkflowEngine({
      executor: recorder,
      databasePath: await makeStateDatabasePath("routing-request"),
    }).run(workflow, {});
    expect(state.status).toBe("completed");
    const [plain, grok, claude] = recorder.requests;
    expect(plain).not.toHaveProperty("agent");
    expect(plain).not.toHaveProperty("model");
    expect(grok).toMatchObject({ agent: "grok-build" });
    expect(grok).not.toHaveProperty("model");
    expect(claude).toMatchObject({ agent: "claude", model: "sonnet" });
  });

  it("keeps agent and model in included workflows and in the definition snapshot", () => {
    const child = defineWorkflow({
      name: "child",
      startAt: "inspect",
      nodes: { inspect: agent({ prompt, agent: "claude", model: "sonnet" }) },
      edges: [],
      exits: { done: { from: "inspect", validate: (value: unknown) => value } },
    });
    const parent = defineWorkflow({
      name: "parent",
      startAt: "start",
      nodes: { start: compute({ run: () => ({}) }) },
      includes: { child: includeWorkflow(child) },
      edges: [{ from: "start", to: "child" }],
    });
    const compiled = compileWorkflowDefinition(parent);
    expect(compiled.nodes["child/inspect"]).toMatchObject({ agent: "claude", model: "sonnet" });
    const snapshot = createDefinitionSnapshot(compiled);
    expect(snapshot.nodes["child/inspect"]).toMatchObject({ agent: "claude", model: "sonnet" });
    child.nodes.inspect.model = "opus";
    expect(createDefinitionSnapshot(compileWorkflowDefinition(parent))).not.toEqual(snapshot);
  });
});

/** An executor that records what it was asked and answers from a function. */
class FakeExecutor implements AgentStepExecutor {
  readonly requests: AgentStepRequest[] = [];
  constructor(
    readonly label: string,
    private readonly answer: (request: AgentStepRequest) => Promise<AgentStepSubmission>,
    flags: Partial<
      Pick<
        AgentStepExecutor,
        "assistantMessageMode" | "preservesActiveTimeBudget" | "enforcesToolAllowlist"
      >
    > = {},
  ) {
    Object.assign(this, flags);
  }
  async runAgentStep(request: AgentStepRequest): Promise<AgentStepSubmission> {
    this.requests.push(request);
    return await this.answer(request);
  }
}

const answerWith = (label: string) => async (request: AgentStepRequest) => {
  const accepted = await request.accept({ ranOn: label, node: request.contract.nodeId });
  if (!accepted.ok) throw new Error(accepted.error);
  return { output: accepted.value };
};

function routing(runExecutor: AgentStepExecutor, acpx: Map<string, FakeExecutor>) {
  return new AgentRoutingExecutor(runExecutor, (name, model) => {
    const executor = new FakeExecutor(`acpx:${name}:${model ?? "-"}`, answerWith(`acpx:${name}`));
    acpx.set(`${name}:${model ?? "-"}`, executor);
    return executor;
  });
}

const request = (fields: Partial<AgentStepRequest> = {}, contract = {}): AgentStepRequest => ({
  contract: {
    requestId: "r1",
    runId: "run",
    workflowName: "w",
    nodeId: "step",
    attemptId: "a1",
    completion: "submit",
    ...contract,
  },
  prompt: "p",
  accept: async (output) => ({ ok: true, value: output }),
  ...fields,
});

describe("AgentRoutingExecutor", () => {
  it("sends a request without agent to the run's executor, the same request, nothing else", async () => {
    const runExecutor = new FakeExecutor("run", answerWith("run"));
    const acpx = new Map<string, FakeExecutor>();
    const plain = request();
    const signal = new AbortController().signal;
    const result = await routing(runExecutor, acpx).runAgentStep(plain, signal);
    expect(result.output).toEqual({ ranOn: "run", node: "step" });
    expect(runExecutor.requests).toEqual([plain]);
    expect(runExecutor.requests[0]).toBe(plain);
    expect(acpx.size).toBe(0);
  });

  it("sends a request with agent to an acpx executor for that agent and model, never to the run's", async () => {
    const runExecutor = new FakeExecutor("run", answerWith("run"));
    const acpx = new Map<string, FakeExecutor>();
    const executor = routing(runExecutor, acpx);
    const signal = new AbortController().signal;
    const grok = await executor.runAgentStep(request({ agent: "grok-build" }), signal);
    const claude = await executor.runAgentStep(
      request({ agent: "claude", model: "sonnet" }),
      signal,
    );
    expect(grok.output).toEqual({ ranOn: "acpx:grok-build", node: "step" });
    expect(claude.output).toEqual({ ranOn: "acpx:claude", node: "step" });
    expect([...acpx.keys()]).toEqual(["grok-build:-", "claude:sonnet"]);
    expect(runExecutor.requests).toEqual([]);
  });

  it("reports the run's own executor's capability flags, whatever they are", () => {
    const flags = [
      {},
      { assistantMessageMode: "unsupported" as const },
      {
        assistantMessageMode: "visible" as const,
        preservesActiveTimeBudget: true,
        enforcesToolAllowlist: true,
      },
      { assistantMessageMode: "park" as const },
    ];
    for (const own of flags) {
      const router = routing(new FakeExecutor("run", answerWith("run"), own), new Map());
      expect(router.assistantMessageMode).toBe(own.assistantMessageMode);
      expect(router.preservesActiveTimeBudget).toBe(own.preservesActiveTimeBudget);
      expect(router.enforcesToolAllowlist).toBe(own.enforcesToolAllowlist);
    }
  });

  it("refuses an agent request that needs assistant completion or an allowlist", async () => {
    const acpx = new Map<string, FakeExecutor>();
    const router = routing(new FakeExecutor("run", answerWith("run")), acpx);
    const signal = new AbortController().signal;
    await expect(
      router.runAgentStep(request({ agent: "claude" }, { completion: "assistant" }), signal),
    ).rejects.toThrow(/"step" sets agent "claude", which does not support assistantMessage\(\)/);
    await expect(
      router.runAgentStep(request({ agent: "claude" }, { allowedTools: ["read"] }), signal),
    ).rejects.toThrow(/does not support allowedTools/);
    expect(acpx.size).toBe(0);
  });

  it("builds the real acpx executor with the run's cwd, a state folder inside the run's, and the model", () => {
    expect(acpxRunStateDir("/state/server", "run-1")).toBe(
      path.join("/state/server", "acpx", "run-1"),
    );
    const router = new AgentRoutingExecutor(
      new FakeExecutor("run", answerWith("run")),
      acpxExecutorFactory({ cwd: "/project", stateDir: "/state/server/acpx/run-1" }),
    );
    expect(router).toBeInstanceOf(AgentRoutingExecutor);
  });
});

const mixedWorkflow = defineWorkflow({
  name: "mixed",
  startAt: "plain1",
  nodes: {
    plain1: agent({ prompt }),
    remote: agent({ prompt, agent: "claude", model: "sonnet" }),
    plain2: agent({ prompt }),
    done: compute({
      run: ({ outputs }) => ({
        plain1: outputs.plain1,
        remote: outputs.remote,
        plain2: outputs.plain2,
      }),
    }),
  },
  edges: [
    { from: "plain1", to: "remote" },
    { from: "remote", to: "plain2" },
    { from: "plain2", to: "done" },
  ],
});

describe("runs that mix a step with an agent and steps without", () => {
  it("headless: steps without an agent run on the run's executor, the step with one on acpx", async () => {
    const headless = new FakeExecutor("pi-rpc", answerWith("pi-rpc"), {
      assistantMessageMode: "unsupported",
    });
    const acpx = new Map<string, FakeExecutor>();
    const { state } = await new WorkflowEngine({
      executor: routing(headless, acpx),
      databasePath: await makeStateDatabasePath("routing-headless"),
    }).run(mixedWorkflow, {});
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toEqual({
      plain1: { ranOn: "pi-rpc", node: "plain1" },
      remote: { ranOn: "acpx:claude", node: "remote" },
      plain2: { ranOn: "pi-rpc", node: "plain2" },
    });
    expect(headless.requests.map((r) => r.contract.nodeId)).toEqual(["plain1", "plain2"]);
    expect(acpx.get("claude:sonnet")?.requests.map((r) => r.contract.nodeId)).toEqual(["remote"]);
  });

  it("headless: still fails a step with assistant completion, as the run's executor cannot do it", async () => {
    const workflow = defineWorkflow({
      name: "headless-assistant",
      startAt: "say",
      nodes: { say: agent({ prompt, expectedOutput: assistantMessage() }) },
      edges: [],
    });
    const headless = new FakeExecutor("pi-rpc", answerWith("pi-rpc"), {
      assistantMessageMode: "unsupported",
    });
    const { state } = await new WorkflowEngine({
      executor: routing(headless, new Map()),
      databasePath: await makeStateDatabasePath("routing-headless-assistant"),
    }).run(workflow, {});
    expect(state.status).toBe("failed");
    expect(state.error).toContain("Assistant completion requires an origin Pi session");
    expect(headless.requests).toEqual([]);
  });

  it("interactive: parks at steps without an agent, runs the step with one inline, and resumes", async () => {
    const databasePath = await makeStateDatabasePath("routing-interactive");
    const acpx = new Map<string, FakeExecutor>();
    // The run's own interactive executor parks a step until the origin session has answered it.
    const answered = new Set<string>();
    const parkedAt: string[] = [];
    const interactive = new FakeExecutor(
      "interactive",
      async (step) => {
        if (!answered.has(step.contract.nodeId)) {
          parkedAt.push(step.contract.nodeId);
          throw new RunParkedError();
        }
        return await answerWith("interactive")(step);
      },
      {
        assistantMessageMode: "visible",
        enforcesToolAllowlist: true,
        preservesActiveTimeBudget: true,
      },
    );
    const launch = () => new WorkflowEngine({ executor: routing(interactive, acpx), databasePath });

    const first = await launch().run(mixedWorkflow, {});
    expect(first.state.status).toBe("running");
    expect(parkedAt).toEqual(["plain1"]);
    expect(acpx.size).toBe(0);

    answered.add("plain1");
    const second = await launch().resumeRun(mixedWorkflow, first.runId);
    expect(second.state.status).toBe("running");
    expect(parkedAt).toEqual(["plain1", "plain2"]);
    expect(acpx.get("claude:sonnet")?.requests.map((r) => r.contract.nodeId)).toEqual(["remote"]);

    answered.add("plain2");
    const third = await launch().resumeRun(mixedWorkflow, first.runId);
    expect(third.state.status).toBe("completed");
    expect(third.state.finalOutput).toEqual({
      plain1: { ranOn: "interactive", node: "plain1" },
      remote: { ranOn: "acpx:claude", node: "remote" },
      plain2: { ranOn: "interactive", node: "plain2" },
    });
    // The step on acpx ran once, never parked, and never reached the interactive executor.
    expect(acpx.get("claude:sonnet")?.requests).toHaveLength(1);
    expect(interactive.requests.some((r) => r.contract.nodeId === "remote")).toBe(false);
  });
});

/** An acpx runtime that holds its turn open until it is cancelled, and records its teardown. */
class HangingRuntime implements AcpxStepRuntime {
  cancels = 0;
  shutdowns = 0;
  started: Promise<void>;
  private markStarted: () => void = () => undefined;

  constructor(readonly input: AcpxRuntimeFactoryInput) {
    this.started = new Promise((resolve) => (this.markStarted = resolve));
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    return { sessionKey: input.sessionKey, backend: "fake", runtimeSessionName: "fake" };
  }

  async setModel(): Promise<void> {}

  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
    let cancel: () => void = () => undefined;
    const result = new Promise<AcpRuntimeTurnResult>((resolve) => {
      cancel = () => resolve({ status: "cancelled", stopReason: "cancelled" });
    });
    this.markStarted();
    return {
      requestId: input.requestId,
      promptStarted: Promise.resolve(),
      events: (async function* () {})(),
      result,
      cancel: async () => {
        this.cancels += 1;
        cancel();
      },
      closeStream: async () => undefined,
    };
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
}

function realAcpxRouting(runtimes: HangingRuntime[], stateDir: string, run: AgentStepExecutor) {
  return new AgentRoutingExecutor(
    run,
    acpxExecutorFactory({
      cwd: stateDir,
      stateDir,
      abortGraceMs: 500,
      runtimeFactory: (input) => {
        const runtime = new HangingRuntime(input);
        runtimes.push(runtime);
        return runtime;
      },
    }),
  );
}

const neverCalled: AgentStepExecutor = { runAgentStep: vi.fn() };

describe("cancelling a run during a step on acpx", () => {
  it("engine cancel aborts the acpx step: turn cancelled, runtime shut down, private channel removed", async () => {
    const runtimes: HangingRuntime[] = [];
    const stateDir = await makeTempDir("routing-cancel-state");
    const router = realAcpxRouting(runtimes, stateDir, neverCalled);
    const engine = new WorkflowEngine({
      executor: router,
      databasePath: await makeStateDatabasePath("routing-cancel"),
    });
    const workflow = defineWorkflow({
      name: "cancel-acpx",
      startAt: "remote",
      nodes: { remote: agent({ prompt, agent: "claude" }) },
      edges: [],
    });
    const running = engine.run(workflow, {});
    await waitUntil(() => runtimes[0] !== undefined);
    await runtimes[0]!.started;
    const socket = runtimes[0]!.input.mcpServers[0]!.env.find(
      (entry) => entry.name === "PI_WORKFLOWS_ACPX_SOCKET",
    )!.value;
    expect(fs.existsSync(socket)).toBe(true);

    engine.cancel();
    const { state } = await running;
    expect(state.status).toBe("cancelled");
    // The engine returns as soon as the step is aborted; the runner then waits in close() for the
    // acpx step to finish tearing its agent down.
    await router.close();
    expect(runtimes[0]!.cancels).toBe(1);
    expect(runtimes[0]!.shutdowns).toBe(1);
    expect(fs.existsSync(path.dirname(socket))).toBe(false);
    expect(neverCalled.runAgentStep).not.toHaveBeenCalled();
  });

  it("close() cancels a running acpx step and returns only after the agent is torn down", async () => {
    const runtimes: HangingRuntime[] = [];
    const stateDir = await makeTempDir("routing-close-state");
    const router = realAcpxRouting(runtimes, stateDir, neverCalled);
    const step = router
      .runAgentStep(request({ agent: "grok-build" }), new AbortController().signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await waitUntil(() => runtimes[0] !== undefined);
    await runtimes[0]!.started;

    await router.close();
    const error = await step;
    expect(error).toBeInstanceOf(CancelledError);
    expect(isAbortLikeError(error)).toBe(true);
    expect(runtimes[0]!.cancels).toBe(1);
    expect(runtimes[0]!.shutdowns).toBe(1);

    // After close(), a new acpx step does not start anything.
    await expect(
      router.runAgentStep(request({ agent: "grok-build" }), new AbortController().signal),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(runtimes).toHaveLength(1);
  });

  it("close() does not touch the run's own executor", async () => {
    const own = new FakeExecutor("run", answerWith("run"));
    const router = routing(own, new Map());
    await router.close();
    await expect(
      router.runAgentStep(request(), new AbortController().signal),
    ).resolves.toMatchObject({ output: { ranOn: "run" } });
  });
});
