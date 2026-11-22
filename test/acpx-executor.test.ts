import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  AcpxStepExecutor,
  type AcpxMcpServer,
  type AcpxRuntimeFactoryInput,
  type AcpxStepExecutorOptions,
  type AcpxStepRuntime,
} from "../src/server/acpx-executor.js";
import { SubmissionChannel } from "../src/server/acpx-submission-channel.js";
import { MAX_SUBMISSION_REMINDERS } from "../src/server/recovery.js";
import type { StepActivityBody } from "../src/state/step-activity.js";
import { CancelledError, isAbortLikeError } from "../src/workflows/errors.js";
import { WorkflowSubmissionToolParameters } from "../src/workflows/tool-input.js";
import type { AgentStepExecutor, AgentStepRequest } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

type ToolAnswer = { text: string; isError: boolean };
type Call = (args: unknown) => Promise<ToolAnswer>;
type Behaviour = (call: Call) => Promise<AcpRuntimeTurnResult | void>;

/** A bare JSON-RPC client for the real MCP script, the way an agent would talk to it. */
class McpClient {
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();
  private readonly exited: Promise<void>;

  private constructor(private readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      this.waiting.get(message.id as number)?.(message);
    });
    this.exited = new Promise((resolve) => child.once("exit", () => resolve()));
  }

  static async start(server: AcpxMcpServer): Promise<McpClient> {
    const env = { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) };
    const client = new McpClient(
      spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "ignore"] }),
    );
    await client.request("initialize", { protocolVersion: "2024-11-05" });
    client.child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    return client;
  }

  get pid(): number {
    return this.child.pid!;
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const answer = new Promise<Record<string, unknown>>((resolve) => this.waiting.set(id, resolve));
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return answer;
  }

  async callTool(args: unknown, name = "workflow"): Promise<ToolAnswer> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const result = reply.result as { content: Array<{ text: string }>; isError: boolean };
    return { text: result.content[0]!.text, isError: result.isError };
  }

  async close(): Promise<void> {
    this.child.stdin!.end();
    await this.exited;
  }
}

/** An acpx runtime whose "model" is a script of tool calls made through the real MCP server. */
class FakeRuntime implements AcpxStepRuntime {
  readonly texts: string[] = [];
  readonly models: string[] = [];
  readonly sessions: AcpRuntimeEnsureInput[] = [];
  shutdowns = 0;
  cancels = 0;
  client: McpClient | undefined;

  constructor(
    readonly input: AcpxRuntimeFactoryInput,
    private readonly behaviours: Behaviour[],
    private readonly options: {
      failModel?: string;
      failTurn?: string;
      events?: AcpRuntimeEvent[];
    } = {},
  ) {}

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    this.sessions.push(input);
    return { sessionKey: input.sessionKey, backend: "fake", runtimeSessionName: "fake" };
  }

  async setModel(input: { model: string }): Promise<void> {
    if (this.options.failModel !== undefined) throw new Error(this.options.failModel);
    this.models.push(input.model);
  }

  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
    const index = this.texts.push(input.text) - 1;
    const turnEvents = this.options.events ?? [];
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<AcpRuntimeTurnResult>((resolve) => {
      cancel = () => resolve({ status: "cancelled", stopReason: "cancelled" });
    });
    return {
      requestId: input.requestId,
      promptStarted: Promise.resolve(),
      events: (async function* () {
        for (const event of turnEvents) yield event;
      })(),
      result: Promise.race([this.play(index), cancelled]),
      cancel: async () => {
        this.cancels += 1;
        cancel();
      },
      closeStream: async () => undefined,
    };
  }

  private async play(index: number): Promise<AcpRuntimeTurnResult> {
    if (this.options.failTurn !== undefined) {
      return { status: "failed", error: { message: this.options.failTurn } };
    }
    this.client ??= await McpClient.start(this.input.mcpServers[0]!);
    const client = this.client;
    const ended = await this.behaviours[index]?.((args) => client.callTool(args));
    return ended ?? { status: "completed", stopReason: "end_turn" };
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
    await this.client?.close();
  }
}

const REQUEST_ID = "req-1";
const submit = (output: unknown) => ({ action: "submit", requestId: REQUEST_ID, output });
const hang: Behaviour = () => new Promise<never>(() => undefined);

function makeRequest(overrides: Partial<AgentStepRequest> = {}): AgentStepRequest {
  return {
    contract: {
      requestId: REQUEST_ID,
      runId: "run-1",
      workflowName: "demo",
      nodeId: "implement",
      attemptId: "att-1",
      completion: "submit",
      expectedOutput: "an object with an answer",
    },
    prompt: "Work out 2+2.",
    accept: async (output) => ({ ok: true as const, value: output }),
    ...overrides,
  };
}

async function setup(
  behaviours: Behaviour[],
  options: Partial<AcpxStepExecutorOptions> = {},
  fake: ConstructorParameters<typeof FakeRuntime>[2] = {},
) {
  const dir = await makeTempDir("acpx-executor");
  let runtime: FakeRuntime | undefined;
  const factory = vi.fn((input: AcpxRuntimeFactoryInput) => {
    runtime = new FakeRuntime(input, behaviours, fake);
    return runtime;
  });
  const executor = new AcpxStepExecutor({
    cwd: dir,
    agent: "fake-agent",
    stateDir: path.join(dir, "state"),
    runtimeFactory: factory,
    ...options,
  });
  return { executor, factory, runtime: () => runtime! };
}

describe("AcpxStepExecutor", () => {
  it("does not claim assistant completion or tool allowlists", async () => {
    const { executor } = await setup([]);
    expect(executor.assistantMessageMode).toBe("unsupported");
    expect((executor as AgentStepExecutor).enforcesToolAllowlist).toBeUndefined();
  });

  it("resolves with the accepted value and tears the agent down", async () => {
    const { executor, runtime } = await setup([
      async (call) => void (await call(submit({ answer: 4 }))),
    ]);
    const accept = vi.fn(async (output: unknown) => ({ ok: true as const, value: output }));
    const result = await executor.runAgentStep(
      makeRequest({ accept }),
      new AbortController().signal,
    );

    expect(result).toEqual({ output: { answer: 4 } });
    expect(accept).toHaveBeenCalledExactlyOnceWith({ answer: 4 });
    expect(runtime().shutdowns).toBe(1);
    expect(runtime().texts).toHaveLength(1);
    expect(runtime().texts[0]).toContain("Work out 2+2.");
    expect(runtime().texts[0]).toContain("workflow__workflow");
    expect(runtime().sessions).toEqual([
      expect.objectContaining({
        agent: "fake-agent",
        mode: "oneshot",
        sessionKey: expect.stringContaining("att-1"),
      }),
    ]);
    expect(() => process.kill(runtime().client!.pid, 0)).toThrow();
  });

  it("returns a rejected submission's error to the model, which then corrects it", async () => {
    const answers: ToolAnswer[] = [];
    const { executor, runtime } = await setup([
      async (call) => {
        answers.push(await call(submit(5)));
        answers.push(await call(submit(4)));
      },
    ]);
    const accept = vi.fn(async (output: unknown) =>
      output === 4
        ? { ok: true as const, value: output }
        : { ok: false as const, error: "answer must be 4" },
    );
    const result = await executor.runAgentStep(
      makeRequest({ accept }),
      new AbortController().signal,
    );

    expect(result).toEqual({ output: 4 });
    expect(accept).toHaveBeenCalledTimes(2);
    expect(answers[0]!.isError).toBe(true);
    expect(answers[0]!.text).toContain("answer must be 4");
    expect(answers[0]!.text).toContain("corrected output");
    expect(answers[1]).toEqual({ isError: false, text: expect.stringContaining("accepted") });
    expect(runtime().texts).toHaveLength(1);
  });

  it("rejects a call whose requestId is not this step's", async () => {
    const answers: ToolAnswer[] = [];
    const { executor } = await setup([
      async (call) => {
        answers.push(await call({ action: "submit", requestId: "someone-else", output: 1 }));
        answers.push(await call({ action: "nonsense" }));
        answers.push(await call(submit(1)));
      },
    ]);
    const accept = vi.fn(async (output: unknown) => ({ ok: true as const, value: output }));
    await executor.runAgentStep(makeRequest({ accept }), new AbortController().signal);

    expect(answers[0]!.isError).toBe(true);
    expect(answers[0]!.text).toContain('"someone-else" does not belong to this step');
    expect(answers[0]!.text).toContain(`"${REQUEST_ID}"`);
    expect(answers[1]!.isError).toBe(true);
    expect(accept).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("forwards updates to publishUpdate with a per-call idempotency key", async () => {
    const answers: ToolAnswer[] = [];
    const update = { type: "progress", key: "step", data: { done: 1 } };
    const { executor } = await setup([
      async (call) => {
        answers.push(await call({ action: "update", requestId: REQUEST_ID, update }));
        answers.push(await call(submit("x")));
      },
    ]);
    const publishUpdate = vi.fn(async () => ({}) as never);
    await executor.runAgentStep(makeRequest({ publishUpdate }), new AbortController().signal);

    expect(publishUpdate).toHaveBeenCalledExactlyOnceWith(
      update,
      expect.stringMatching(/^acpx:att-1:/),
    );
    expect(answers[0]).toEqual({
      isError: false,
      text: expect.stringContaining("update recorded"),
    });
  });

  it("tells the model when updates are unsupported or rejected", async () => {
    const answers: ToolAnswer[] = [];
    const update = { type: "progress", key: "step", data: {} };
    const behaviour: Behaviour = async (call) => {
      answers.push(await call({ action: "update", requestId: REQUEST_ID, update }));
      await call(submit("x"));
    };
    const first = await setup([behaviour]);
    await first.executor.runAgentStep(makeRequest(), new AbortController().signal);
    const second = await setup([behaviour]);
    const publishUpdate = vi.fn(async () => {
      throw new Error("no such run");
    });
    await second.executor.runAgentStep(
      makeRequest({ publishUpdate }),
      new AbortController().signal,
    );

    expect(answers[0]).toEqual({
      isError: true,
      text: expect.stringContaining("does not support step updates"),
    });
    expect(answers[1]).toEqual({
      isError: true,
      text: expect.stringContaining("update rejected: no such run"),
    });
  });

  it("fails the step when accept itself throws", async () => {
    const { executor } = await setup([async (call) => void (await call(submit(1)))]);
    const accept = vi.fn(async () => {
      throw new Error("claim lost");
    });
    await expect(
      executor.runAgentStep(makeRequest({ accept }), new AbortController().signal),
    ).rejects.toThrow("claim lost");
  });

  it("sends exactly the bounded reminders, then fails clearly", async () => {
    expect(MAX_SUBMISSION_REMINDERS).toBe(2);
    const { executor, runtime } = await setup([]);
    const error = (await executor.runAgentStep(makeRequest(), new AbortController().signal).then(
      () => undefined,
      (caught: unknown) => caught,
    )) as Error;

    expect(error.message).toContain('Workflow step "implement"');
    expect(error.message).toContain("ended without a submission");
    expect(error.message).toContain("after 2 reminders");
    expect(runtime().texts).toHaveLength(3);
    for (const reminder of runtime().texts.slice(1)) {
      expect(reminder).toContain(`"requestId": "${REQUEST_ID}"`);
      expect(reminder).toContain('"action": "submit"');
      expect(reminder).toContain("an object with an answer");
    }
    expect(runtime().shutdowns).toBe(1);
    expect(runtime().sessions).toHaveLength(1);
  });

  it("accepts a submission that arrives after a reminder", async () => {
    const { executor, runtime } = await setup([
      async () => undefined,
      async (call) => void (await call(submit("late"))),
    ]);
    const result = await executor.runAgentStep(makeRequest(), new AbortController().signal);
    expect(result).toEqual({ output: "late" });
    expect(runtime().texts).toHaveLength(2);
  });

  it("reports turn events to onActivity as live step activity and survives a throwing callback", async () => {
    const events: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "Think ", stream: "thought" },
      { type: "text_delta", text: "about 2+2." },
      { type: "status", text: "thinking hard" },
      { type: "status", text: "tokens used", tag: "usage_update", used: 12, size: 34 },
      {
        type: "tool_call",
        text: "Read README.md",
        toolCallId: "call-1",
        title: "Read",
        kind: "read",
        rawInput: { path: "README.md" },
      },
      { type: "done", stopReason: "end_turn" },
    ];
    const { executor } = await setup(
      [async (call) => void (await call(submit({ answer: 4 })))],
      {},
      { events },
    );
    const bodies: StepActivityBody[] = [];
    const result = await executor.runAgentStep(
      makeRequest({
        onActivity: (body) => {
          bodies.push(body);
          if (bodies.length === 2) throw new Error("activity callback exploded");
        },
      }),
      new AbortController().signal,
    );

    expect(result).toEqual({ output: { answer: 4 } });
    expect(bodies).toEqual([
      { kind: "thought", text: "Think " },
      { kind: "text", text: "about 2+2." },
      { kind: "status", text: "thinking hard" },
      {
        kind: "tool",
        text: "Read README.md",
        tool: { toolCallId: "call-1", title: "Read", kind: "read", input: { path: "README.md" } },
      },
    ]);
  });

  it("cancels, shuts down and rejects abort-like when the signal aborts", async () => {
    const { executor, runtime } = await setup([hang], { abortGraceMs: 200 });
    const abort = new AbortController();
    const step = executor
      .runAgentStep(makeRequest(), abort.signal)
      .catch((caught: unknown) => caught);
    await vi.waitFor(() => expect(runtime().client).toBeDefined());
    abort.abort(new CancelledError());
    const error = await step;

    expect(isAbortLikeError(error)).toBe(true);
    expect(runtime().cancels).toBe(1);
    expect(runtime().shutdowns).toBe(1);
    expect(() => process.kill(runtime().client!.pid, 0)).toThrow();
  });

  it("rejects abort-like without starting a runtime when the signal is already aborted", async () => {
    const { executor, factory } = await setup([]);
    const abort = new AbortController();
    abort.abort();
    const error = await executor
      .runAgentStep(makeRequest(), abort.signal)
      .catch((caught: unknown) => caught);
    expect(isAbortLikeError(error) || error === abort.signal.reason).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects with the runtime's message when the turn fails, unchanged", async () => {
    const message = 'Cannot apply --model "grok-4.7": the ACP agent did not advertise that model';
    const { executor, runtime } = await setup([], {}, { failTurn: message });
    await expect(
      executor.runAgentStep(makeRequest(), new AbortController().signal),
    ).rejects.toThrow(message);
    expect(runtime().shutdowns).toBe(1);
  });

  it("rejects with the runtime's message when the model cannot be set", async () => {
    const message = 'Cannot apply --model "nope": the ACP agent did not advertise that model';
    const { executor } = await setup([], { model: "nope" }, { failModel: message });
    await expect(
      executor.runAgentStep(makeRequest(), new AbortController().signal),
    ).rejects.toThrow(message);
  });

  it("sets the model when one is given and leaves the agent's default when not", async () => {
    const withModel = await setup([async (call) => void (await call(submit(1)))], {
      model: "grok-4.7",
    });
    await withModel.executor.runAgentStep(makeRequest(), new AbortController().signal);
    const without = await setup([async (call) => void (await call(submit(1)))]);
    await without.executor.runAgentStep(makeRequest(), new AbortController().signal);

    expect(withModel.runtime().models).toEqual(["grok-4.7"]);
    expect(without.runtime().models).toEqual([]);
  });

  it("hands the runtime a private MCP server and kills an agent process that outlives shutdown", async () => {
    let stray: ChildProcess | undefined;
    const { executor, factory } = await setup(
      [
        async (call) => {
          const lifecycle = factory.mock.calls[0]![0].processLifecycle;
          stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
          await lifecycle.onSpawned!({ pid: stray.pid! } as never);
          await call(submit(1));
        },
      ],
      { abortGraceMs: 100 },
    );
    await executor.runAgentStep(makeRequest(), new AbortController().signal);

    const server = factory.mock.calls[0]![0].mcpServers[0]!;
    expect(server.name).toBe("workflow");
    expect(server.command).toBe(process.execPath);
    const env = Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]));
    expect(Object.keys(env).sort()).toEqual([
      "PI_WORKFLOWS_ACPX_SCHEMA",
      "PI_WORKFLOWS_ACPX_SOCKET",
      "PI_WORKFLOWS_ACPX_TOKEN",
    ]);
    expect(JSON.parse(env.PI_WORKFLOWS_ACPX_SCHEMA!)).toEqual(
      JSON.parse(JSON.stringify(WorkflowSubmissionToolParameters)),
    );
    // The private socket folder is gone, and the straggler was killed.
    expect(fs.existsSync(env.PI_WORKFLOWS_ACPX_SOCKET!)).toBe(false);
    await vi.waitFor(() =>
      expect(stray!.exitCode !== null || stray!.signalCode !== null).toBe(true),
    );
  });

  it("tells the process registry about each agent process, and unregisters a killed straggler", async () => {
    const calls: string[] = [];
    const registry = {
      register: (pid: number) => void calls.push(`register ${pid}`),
      unregister: (pid: number) => void calls.push(`unregister ${pid}`),
    };
    let stray: ChildProcess | undefined;
    const { executor, factory } = await setup(
      [
        async (call) => {
          const lifecycle = factory.mock.calls[0]![0].processLifecycle;
          stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
          await lifecycle.onSpawned!({ pid: stray.pid! } as never);
          await call(submit(1));
        },
      ],
      { abortGraceMs: 100, registry },
    );
    await executor.runAgentStep(makeRequest(), new AbortController().signal);
    expect(calls).toEqual([`register ${stray!.pid}`, `unregister ${stray!.pid}`]);
  });

  it("fails the step when the registry refuses an agent process", async () => {
    const registry = {
      register: () => Promise.reject(new Error("Runner process is not a direct child")),
      unregister: () => undefined,
    };
    let stray: ChildProcess | undefined;
    const { executor, factory } = await setup(
      [
        async () => {
          stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
          await factory.mock.calls[0]![0].processLifecycle.onSpawned!({ pid: stray.pid! } as never);
          await hang(() => Promise.resolve({ text: "", isError: false }));
        },
      ],
      { abortGraceMs: 100, registry },
    );
    await expect(
      executor.runAgentStep(makeRequest(), new AbortController().signal),
    ).rejects.toThrow("Runner process is not a direct child");
    await vi.waitFor(() =>
      expect(stray!.exitCode !== null || stray!.signalCode !== null).toBe(true),
    );
  });
});

describe("acpx submission channel and MCP script", () => {
  async function openScript(handler: Parameters<typeof SubmissionChannel.open>[0]) {
    const channel = await SubmissionChannel.open(handler);
    const script = fileScriptPath();
    const client = await McpClient.start({
      name: "workflow",
      command: process.execPath,
      args: [script],
      env: Object.entries(channel.env({ type: "object", title: "schema-from-env" })).map(
        ([name, value]) => ({ name, value }),
      ),
    });
    return { channel, client };
  }

  function fileScriptPath(): string {
    return path.join(import.meta.dirname, "..", "src", "server", "acpx-submit-mcp.ts");
  }

  it("answers initialize, tools/list and tools/call over stdio and forwards the call", async () => {
    const handler = vi.fn(async () => ({ ok: true, text: "accepted" }));
    const { channel, client } = await openScript(handler);
    const listed = await client.request("tools/list");
    const tool = (listed.result as { tools: Array<Record<string, unknown>> }).tools[0]!;
    expect(tool.name).toBe("workflow");
    expect(tool.inputSchema).toEqual({ type: "object", title: "schema-from-env" });

    expect(await client.callTool({ action: "submit", requestId: "r", output: {} })).toEqual({
      isError: false,
      text: "accepted",
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      callId: expect.any(Number),
      arguments: { action: "submit", requestId: "r", output: {} },
    });
    expect(
      (await client.request("tools/call", { name: "other", arguments: {} })).error,
    ).toMatchObject({ code: -32602 });
    expect((await client.request("nope")).error).toMatchObject({ code: -32601 });
    expect((await client.request("ping")).result).toEqual({});
    await client.close();
    await channel.close();
  });

  it("reports an unavailable channel to the model instead of crashing", async () => {
    const { channel, client } = await openScript(async () => ({ ok: true, text: "unused" }));
    await channel.close();
    const answer = await client.callTool({ action: "submit", requestId: "r", output: 1 });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("channel is unavailable");
    await client.close();
  });

  it("refuses a call without the step token and removes its folder on close", async () => {
    const handler = vi.fn(async () => ({ ok: true, text: "ok" }));
    const channel = await SubmissionChannel.open(handler);
    const ask = (token: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(channel.socketPath);
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => (data += chunk));
        socket.on("close", () => resolve(data));
        socket.write(`${JSON.stringify({ token, callId: 1, arguments: {} })}\n`);
      });

    expect(JSON.parse(await ask("wrong"))).toMatchObject({ ok: false });
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(await ask(channel.token))).toEqual({ ok: true, text: "ok" });
    expect(handler).toHaveBeenCalledOnce();
    await channel.close();
    expect(fs.existsSync(path.dirname(channel.socketPath))).toBe(false);
  });
});
