#!/usr/bin/env node
// Live proof of per-step agents through the real workflow server (not part of `npm test`).
//
//   npm run build
//   node scripts/live-acpx-routing.mjs [--pi-provider openai-codex] [--pi-model gpt-5.6-luna]
//
// One workflow, one headless run, four steps and a gate:
//   grok    agent: "grok-build"   runs through acpx
//   gate    human decision        answered through the server the way test/non-pi-coordinator.test.ts does
//   claude  agent: "claude"       runs through acpx
//   pi      no agent              runs on the run's own headless Pi (low-cost model from --pi-*)
// Makes real model calls with tiny prompts. Prints one JSON line per step, then a summary line.
// Everything lives in temporary folders; nothing is deleted. Never prints credentials.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (file) => pathToFileURL(path.join(repo, "dist", file)).href;
const { WorkflowServer } = await import(dist("server/server.js"));
const { WorkflowClient } = await import(dist("client/client.js"));
const { WorkflowRunStore } = await import(dist("workflows/store.js"));

const options = { piProvider: "openai-codex", piModel: "gpt-5.6-luna" };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (flag === "--pi-provider" && value) options.piProvider = value;
  else if (flag === "--pi-model" && value) options.piModel = value;
  else throw new Error(`Unknown or incomplete option: ${flag}`);
}

const ORIGIN = "live-acpx-origin";
const RUN_ID = `live-acpx-routing-${Date.now()}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwx-routing-live-"));
const project = path.join(root, "project");
const stateRoot = path.join(root, "state");
fs.mkdirSync(project);
fs.mkdirSync(stateRoot);
const databasePath = path.join(stateRoot, "state.sqlite");

const step = (who, agentLine) => `agent({
    ${agentLine}
    prompt: () => ${JSON.stringify(`Tiny test. Call the workflow tool to submit exactly {"who": "${who}", "n": 1}. Use no other tool and do not read or write files.`)},
    expectedOutput: ${JSON.stringify(`{"who": "${who}", "n": 1}`)},
    validate: (output) => {
      if (output?.who !== ${JSON.stringify(who)}) throw new Error("who must be ${who}");
      return output;
    },
  })`;
const workflowPath = path.join(project, "live-acpx-routing.workflow.ts");
fs.writeFileSync(
  workflowPath,
  `import { agent, choice, compute, defineHumanChoices, defineWorkflow, humanDecision, humanDecisionEdge } from ${JSON.stringify(dist("workflows/index.js"))};
const choices = defineHumanChoices({ continue: choice({ label: "Continue" }), stop: choice({ label: "Stop" }) });
export default defineWorkflow({
  name: "live-acpx-routing",
  startAt: "grok",
  nodes: {
    grok: ${step("grok", 'agent: "grok-build",')},
    gate: humanDecision({
      audience: "operator",
      choices,
      request: () => ({
        title: "Continue?",
        subject: { task: "live-acpx-routing" },
        presentation: { schema: "pi-workflows.decision-presentation.v1", summary: "Choose whether to continue.", blocks: [] },
      }),
    }),
    claude: ${step("claude", 'agent: "claude",')},
    pi: ${step("pi", "")},
    done: compute({ run: ({ outputs }) => ({ grok: outputs.grok, claude: outputs.claude, pi: outputs.pi }) }),
    stopped: compute({ run: () => ({ stopped: true }) }),
  },
  edges: [
    { from: "grok", to: "gate" },
    humanDecisionEdge({ from: "gate", choices, cases: { continue: "claude", stop: "stopped" } }),
    { from: "claude", to: "pi" },
    { from: "pi", to: "done" },
  ],
});
`,
);

// Agent and MCP processes by kind. Only processes that were not running before this script count.
// A headless Pi child sets its process title, so `ps` shows it as just `pi`.
const KINDS = [
  ["grok agent stdio", /grok.* agent stdio/],
  ["claude-agent-acp", /claude-agent-acp/],
  ["acpx-submit-mcp", /acpx-submit-mcp/],
  ["pi (headless rpc child)", /^(.*\/)?pi$/],
];
const processes = () =>
  execFileSync("ps", ["-axo", "pid,command"], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      const kind = match && KINDS.find(([, pattern]) => pattern.test(match[2]))?.[0];
      return kind ? [{ pid: match[1], kind }] : [];
    });
// Everything this script started, directly or through the server and its runner, by the first
// word of its command (never the arguments), so a headless Pi child shows up whatever its title.
function descendants() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      return match ? [{ pid: match[1], ppid: match[2], name: path.basename(match[3]) }] : [];
    });
  const mine = new Set([String(process.pid)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!mine.has(row.pid) && mine.has(row.ppid)) {
        mine.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => mine.has(row.pid) && row.pid !== String(process.pid));
}
const baseline = new Set(processes().map((p) => p.pid));
const fresh = () => processes().filter((p) => !baseline.has(p.pid));

const log = (value) => console.log(JSON.stringify(value));
const server = new WorkflowServer({
  databasePath,
  claimPollMs: 10,
  piArgs: ["--provider", options.piProvider, "--model", options.piModel],
});
const client = new WorkflowClient({ databasePath, clientId: "live-acpx-routing-client" });
const observed = { kindsByNode: new Map(), nodes: [] };
let exitCode = 1;
const started = Date.now();

function readRun() {
  const store = new WorkflowRunStore(databasePath, { readOnly: true });
  try {
    return store.readRun(RUN_ID)?.state;
  } finally {
    store.close();
  }
}

async function until(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

try {
  await server.start();
  const resolved = await client.resolveWorkflow({ cwd: project, workflowRef: workflowPath });
  const begun = await client.request({
    operation: "run.start",
    runId: RUN_ID,
    payload: {
      projectPath: project,
      workflowName: resolved.workflowName,
      workflowSourceRef: resolved.workflowSourceRef,
      workflowSource: resolved.workflowSource,
      definitionDigest: resolved.definitionDigest,
      definitionSnapshot: resolved.definitionSnapshot,
      input: {},
      launchOptions: {},
      originSessionId: ORIGIN,
      executionMode: "headless",
    },
  });
  log({ event: "run.start", outcome: begun.outcome, runId: RUN_ID, stateRoot });

  let pending = null;
  let epoch = null;
  const unsubscribe = await client.watchSession(
    ORIGIN,
    (event) => {
      if (event.event !== "session_snapshot") return;
      pending = event.payload?.interaction ?? null;
      epoch = event.payload?.coordinatorEpoch ?? null;
    },
    { subscriptionId: "live-acpx-routing-watch", coordinator: true },
  );
  let gateAnswered = false;
  try {
    await until("the session coordinator", () => epoch !== null, 30_000);
    const authority = { targetSessionId: ORIGIN, coordinatorEpoch: epoch };
    await client.request({
      operation: "workflowMessage.reportBranch",
      payload: {
        ...authority,
        workflowMessageId: null,
        piSessionEntryId: null,
        isIdle: true,
        hasPendingMessages: false,
      },
    });

    // Sample the run until it ends: which node is current, which agent processes exist, the gate.
    const deadline = Date.now() + 8 * 60_000;
    for (;;) {
      const state = readRun();
      const node = state?.currentNode;
      if (node !== undefined) {
        const kinds = observed.kindsByNode.get(node) ?? new Set();
        for (const { kind } of fresh()) kinds.add(kind);
        for (const { name } of descendants()) if (name !== "ps") kinds.add(`child:${name}`);
        observed.kindsByNode.set(node, kinds);
      }
      if (!gateAnswered && pending?.kind === "decision") {
        const answered = await client.request({
          operation: "decision.answer",
          idempotencyKey: "live-acpx-routing-gate",
          runId: pending.runId,
          expectedRevision: pending.revision,
          payload: {
            ...authority,
            requestId: pending.requestId,
            submissionId: "live-acpx-routing-gate",
            response: { choice: "continue" },
          },
        });
        gateAnswered = true;
        log({ event: "gate.answer", choice: "continue", outcome: answered.outcome });
      }
      if (state !== undefined && ["completed", "failed", "cancelled"].includes(state.status)) break;
      if (Date.now() > deadline) throw new Error("The run did not finish within 8 minutes");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } finally {
    await unsubscribe();
  }

  const final = readRun();
  const acpxDir = path.join(stateRoot, "server", "acpx", RUN_ID);
  const sessionFiles = fs.existsSync(acpxDir)
    ? fs.readdirSync(acpxDir, { recursive: true }).map(String)
    : [];
  const executorOf = (kinds) =>
    kinds.has("pi (headless rpc child)") || kinds.has("child:pi")
      ? "pi headless rpc"
      : kinds.has("grok agent stdio")
        ? "acpx grok-build"
        : kinds.has("claude-agent-acp")
          ? "acpx claude"
          : "none seen";
  for (const record of final.steps) {
    const kinds = observed.kindsByNode.get(record.nodeId) ?? new Set();
    log({
      event: "step",
      node: record.nodeId,
      executor: executorOf(kinds),
      processKindsSeen: [...kinds],
      outcome: record.outcome,
      output: record.output,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const left = fresh();
  log({
    event: "summary",
    runId: RUN_ID,
    status: final.status,
    error: final.error,
    finalOutput: final.finalOutput,
    gateAnswered,
    ms: Date.now() - started,
    stateRoot,
    acpxStateFolder: acpxDir,
    acpxStateFiles: sessionFiles.length,
    processesLeft: left.map((p) => p.kind),
  });
  exitCode = final.status === "completed" && gateAnswered && left.length === 0 ? 0 : 1;
} catch (error) {
  log({
    event: "error",
    message: error instanceof Error ? error.message : String(error),
    runId: RUN_ID,
    stateRoot,
  });
} finally {
  await client.close();
  await server.stop();
}
process.exit(exitCode);
