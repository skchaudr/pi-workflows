import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ServerProcessRegistry } from "../src/server/processes.js";
import { RpcStepExecutor } from "../src/server/rpc-executor.js";
import type { StepActivityBody } from "../src/state/step-activity.js";
import { makeTempDir, waitUntil } from "./helpers.js";

describe("RpcStepExecutor spawn", () => {
  it("marks assistant responses unsupported unless an origin session can resume them", async () => {
    const dir = await makeTempDir("pi-rpc-assistant-mode");
    const registry = new ServerProcessRegistry(dir);
    expect(new RpcStepExecutor({ cwd: dir, registry }).assistantMessageMode).toBe("unsupported");
    expect(
      new RpcStepExecutor({ cwd: dir, registry, assistantMessageMode: "park" })
        .assistantMessageMode,
    ).toBe("park");
  });

  it("spawns children with extension isolation", async () => {
    const dir = await makeTempDir("pi-rpc-args");
    const argsFile = path.join(dir, "argv.txt");
    const fakePi = path.join(dir, "fake-pi.sh");
    await fs.writeFile(
      fakePi,
      `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
sleep 60
`,
      { encoding: "utf8", mode: 0o755 },
    );
    const registry = new ServerProcessRegistry(dir);
    const executor = new RpcStepExecutor({ cwd: dir, registry, piBin: fakePi });
    const abort = new AbortController();
    const stepPromise = executor
      .runAgentStep(
        {
          contract: {
            requestId: "test-request-1",
            runId: "r",
            workflowName: "w",
            nodeId: "n",
            attemptId: "a",
            completion: "submit",
          },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await executor.close();
    abort.abort(new Error("done"));
    await stepPromise;

    const args = await fs.readFile(argsFile, "utf8");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("rpc-bridge");
    // The bridge is the only extension the child loads.
    const noExtensionsIndex = args.indexOf("--no-extensions");
    const bridgeIndex = args.indexOf("-e\n");
    expect(noExtensionsIndex).toBeGreaterThanOrEqual(0);
    expect(bridgeIndex).toBeGreaterThan(noExtensionsIndex);
  });

  it("fails the step instead of crashing when pi is missing", async () => {
    const dir = await makeTempDir("pi-rpc-missing");
    const registry = new ServerProcessRegistry(dir);
    const executor = new RpcStepExecutor({
      cwd: dir,
      registry,
      piBin: path.join(dir, "definitely-not-a-real-pi-binary"),
    });
    const abort = new AbortController();
    const result = await executor
      .runAgentStep(
        {
          contract: {
            requestId: "test-request-1",
            runId: "r",
            workflowName: "w",
            nodeId: "n",
            attemptId: "a",
            completion: "submit",
          },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
    expect(result).not.toBe("resolved");
    await executor.close();
  });
});

/**
 * A fake pi that answers each prompt on stderr with the submission marker the
 * executor waits for, and first streams a scripted set of RPC records on stdout
 * so the executor can map them to the running step's activity.
 */
async function writeActivityFakePi(dir: string): Promise<string> {
  const fakePi = path.join(dir, "activity-fake-pi.cjs");
  await fs.writeFile(
    fakePi,
    `#!/usr/bin/env node
const readline = require("node:readline");
let step = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "prompt") return;
  step += 1;
  process.stdout.write(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "step " + step + " text" },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "call-" + step,
    toolName: "bash",
    args: { command: "ls" },
  }) + "\\n");
  process.stdout.write("this line is not json\\n");
  const contract = message.message
    .split("\\n")
    .find((candidate) => candidate.startsWith('{"action": "submit"'));
  const action = JSON.parse(contract.replace("<your result>", "null"));
  setTimeout(() => {
    process.stderr.write(
      "PI_WORKFLOWS_STEP_SUBMISSION " +
        JSON.stringify({ ...action, output: { step } }) + "\\n"
    );
  }, 50);
});
setInterval(() => {}, 1000);
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return fakePi;
}

describe("RpcStepExecutor live activity", () => {
  it("maps the Pi child's stdout records to the running step's onActivity, per step", async () => {
    const dir = await makeTempDir("pi-rpc-activity");
    const registry = new ServerProcessRegistry(dir);
    const executor = new RpcStepExecutor({
      cwd: dir,
      registry,
      piBin: await writeActivityFakePi(dir),
    });
    const first: StepActivityBody[] = [];
    const second: StepActivityBody[] = [];
    const step = (bodies: StepActivityBody[], index: number) =>
      executor
        .runAgentStep(
          {
            contract: {
              requestId: "test-request-" + index,
              runId: "r",
              workflowName: "w",
              nodeId: "n",
              attemptId: "a" + index,
              completion: "submit",
            },
            prompt: [
              `hi ${index}`,
              "",
              `{"action": "submit", "requestId": "test-request-${index}", "output": <your result>}`,
            ].join("\n"),
            accept: async (output) => ({ ok: true as const, value: output }),
            onActivity: (body) => bodies.push(body),
          },
          new AbortController().signal,
        )
        .catch(() => undefined);
    await step(first, 1);
    await step(second, 2);
    await executor.close();

    expect(first).toEqual([
      { kind: "text", text: "step 1 text" },
      {
        kind: "tool",
        text: "",
        tool: {
          toolCallId: "call-1",
          title: "bash",
          kind: "bash",
          status: "in_progress",
          input: { command: "ls" },
        },
      },
    ]);
    expect(second).toEqual([
      { kind: "text", text: "step 2 text" },
      {
        kind: "tool",
        text: "",
        tool: {
          toolCallId: "call-2",
          title: "bash",
          kind: "bash",
          status: "in_progress",
          input: { command: "ls" },
        },
      },
    ]);
  });

  it("keeps completing steps when the activity callback throws", async () => {
    const dir = await makeTempDir("pi-rpc-activity-throw");
    const registry = new ServerProcessRegistry(dir);
    const executor = new RpcStepExecutor({
      cwd: dir,
      registry,
      piBin: await writeActivityFakePi(dir),
    });
    const result = await executor.runAgentStep(
      {
        contract: {
          requestId: "test-request-1",
          runId: "r",
          workflowName: "w",
          nodeId: "n",
          attemptId: "a",
          completion: "submit",
        },
        prompt: [
          "hi",
          "",
          '{"action": "submit", "requestId": "test-request-1", "output": <your result>}',
        ].join("\n"),
        accept: async (output) => ({ ok: true as const, value: output }),
        onActivity: () => {
          throw new Error("activity callback exploded");
        },
      },
      new AbortController().signal,
    );
    await executor.close();
    expect(result).toEqual({ output: { step: 1 } });
  });
});

describe("RpcStepExecutor.close", () => {
  it("kills the whole process group, including grandchildren", async () => {
    const dir = await makeTempDir("pi-rpc-close");
    // A fake pi that leaves a grandchild behind: the parent sleeps while a
    // child sleeps in the same group.
    const fakePi = path.join(dir, "fake-pi.sh");
    await fs.writeFile(fakePi, "#!/bin/sh\nsleep 60 &\nexec sleep 60\n", {
      encoding: "utf8",
      mode: 0o755,
    });
    const registry = new ServerProcessRegistry(dir);
    const executor = new RpcStepExecutor({ cwd: dir, registry, piBin: fakePi });
    const abort = new AbortController();
    const stepPromise = executor
      .runAgentStep(
        {
          contract: {
            requestId: "test-request-1",
            runId: "r",
            workflowName: "w",
            nodeId: "n",
            attemptId: "a",
            completion: "submit",
          },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .catch((error: unknown) => error);
    // Give the child a moment to spawn, then close and abort the step.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = (executor as unknown as { child: { pid?: number } | null }).child?.pid;
    expect(pid).toBeDefined();
    await executor.close();
    abort.abort(new Error("done"));
    await stepPromise;
    // The entire group is gone: a group probe fails, and the registry is empty.
    await waitUntil(() => {
      try {
        process.kill(-(pid as number), 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(-(pid as number), 0)).toThrow();
    expect(registry.size).toBe(0);
  });
});
