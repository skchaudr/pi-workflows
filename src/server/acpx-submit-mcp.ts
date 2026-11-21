// Stdio MCP server that exposes the `workflow` submission tool to an agent run through acpx.
//
// The acpx agent spawns this script. It imports nothing from the package: it runs as a bare
// `node` child (type-stripped when loaded from src, compiled to .js in dist), so everything it
// needs arrives in its environment:
//   PI_WORKFLOWS_ACPX_SOCKET  unix socket of the executor step that owns this tool
//   PI_WORKFLOWS_ACPX_TOKEN   per-step token the executor checks on every call
//   PI_WORKFLOWS_ACPX_SCHEMA  JSON of the tool input schema (WorkflowSubmissionToolParameters)
// Each tool call is forwarded to the executor as one JSON line and its answer is returned to the
// model. The script exits when its stdin closes, so an agent that dies leaves nothing behind.
import net from "node:net";
import { createInterface } from "node:readline";

const socketPath = process.env.PI_WORKFLOWS_ACPX_SOCKET ?? "";
const token = process.env.PI_WORKFLOWS_ACPX_TOKEN ?? "";
const inputSchema: unknown = JSON.parse(process.env.PI_WORKFLOWS_ACPX_SCHEMA ?? "{}");

const TOOL = {
  name: "workflow",
  description: [
    "Publish an update or submit the output for the pending workflow step.",
    "Only call this tool when a workflow step contract in the conversation asks you to.",
    "Pass the exact requestId from the contract.",
  ].join(" "),
  inputSchema,
};

type JsonRpcId = string | number | null;
type JsonRpcMessage = { id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
type StepAnswer = { ok: boolean; text: string };

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

/** Forward one call to the executor step and resolve with its one-line answer. */
function forward(args: unknown, callId: JsonRpcId): Promise<StepAnswer> {
  return new Promise((resolve) => {
    const fail = (text: string) => resolve({ ok: false, text });
    const socket = net.connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ token, callId, arguments: args })}\n`),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try {
        resolve(JSON.parse(buffer.slice(0, end)) as StepAnswer);
      } catch {
        fail("The workflow step returned an unreadable answer.");
      }
      socket.destroy();
    });
    socket.on("error", (error) =>
      fail(`The workflow step channel is unavailable: ${error.message}`),
    );
    socket.on("close", () => fail("The workflow step channel closed without an answer."));
  });
}

type Params = Record<string, unknown> | undefined;

function initialize(id: JsonRpcId | undefined, params: Params): void {
  const requested = params?.protocolVersion;
  send({
    id,
    result: {
      protocolVersion: typeof requested === "string" ? requested : "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "pi-workflows-submit", version: "1" },
    },
  });
}

async function callTool(id: JsonRpcId | undefined, params: Params): Promise<void> {
  if (params?.name !== TOOL.name) {
    send({ id, error: { code: -32602, message: `Unknown tool ${String(params?.name)}` } });
    return;
  }
  const answer = await forward(params.arguments ?? {}, id ?? null);
  send({ id, result: { content: [{ type: "text", text: answer.text }], isError: !answer.ok } });
}

const METHODS: Record<string, (id: JsonRpcId | undefined, params: Params) => void | Promise<void>> =
  {
    initialize,
    ping: (id) => send({ id, result: {} }),
    "tools/list": (id) => send({ id, result: { tools: [TOOL] } }),
    "tools/call": callTool,
  };

async function handle({ id, method = "", params }: JsonRpcMessage): Promise<void> {
  const run = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
  if (run !== undefined) {
    await run(id, params);
  } else if (id !== undefined && !method.startsWith("notifications/")) {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  void handle(message);
});
lines.on("close", () => process.exit(0));
