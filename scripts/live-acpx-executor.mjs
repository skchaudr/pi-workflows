#!/usr/bin/env node
// Live proof for AcpxStepExecutor (not part of `npm test`): runs one real step through acpx.
//
//   npm run build
//   node scripts/live-acpx-executor.mjs claude haiku
//
// The step allows only `Read`. The model is told to try `Write` (must be denied), read seed.txt
// with `Read` (must work), then submit 5 first. `accept` rejects it ("answer must be <seed>"), so
// the model has to correct the output and submit again through the MCP `workflow` tool. Prints one
// JSON line: reminders used, submissions seen, the final accepted value, whether the denied file
// exists, and any agent or MCP process still running afterwards. Makes real model calls.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agent = process.argv[2] ?? "claude";
const model = process.argv[3];
const { AcpxStepExecutor, createAcpxRuntime } = await import(
  new URL("../dist/server/acpx-executor.js", import.meta.url)
);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwx-live-state-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pwx-live-cwd-"));
const PROCESS_PATTERN = /agent stdio|claude-agent-acp|pi-acp|acpx-submit-mcp/;
const processes = () =>
  execFileSync("ps", ["-axo", "pid,command"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => PROCESS_PATTERN.test(line))
    .map((line) => line.trim());
const seed = 37;
fs.writeFileSync(path.join(cwd, "seed.txt"), `${seed}\n`);
const deniedFile = path.join(cwd, "denied.txt");
const before = new Set(processes().map((line) => line.split(" ")[0]));

let turns = 0;
const activity = [];
const submissions = [];
const requestId = "live-1";
const request = {
  contract: {
    requestId,
    runId: "live-run",
    workflowName: "live-acpx",
    nodeId: "answer",
    attemptId: `live-${Date.now()}`,
    completion: "submit",
    expectedOutput: 'a JSON object {"answer": <number>}',
    allowedTools: ["Read"],
  },
  prompt: [
    "This is a tiny permissions test. Do these in order:",
    `1. Use the Write tool to create ${deniedFile} containing "x". It may be denied; that is expected, do not retry or work around it.`,
    `2. Use the Read tool to read ${path.join(cwd, "seed.txt")}; it holds a number.`,
    "3. Submit the wrong value 5 as the answer first. If the workflow rejects it, read the error and submit the number from seed.txt.",
    "",
    `Workflow step contract: complete this step by calling the \`workflow\` tool with {"action": "submit", "requestId": "${requestId}", "output": {"answer": <number>}}.`,
    'If the tool reports a validation error, correct the output and call it again. Expected output: a JSON object {"answer": <number>}.',
  ].join("\n"),
  onActivity: (body) => activity.push(body),
  accept: async (output) => {
    submissions.push(output);
    const answer = output?.answer;
    return answer === seed
      ? { ok: true, value: output }
      : { ok: false, error: "answer must be the number in seed.txt" };
  },
};

const executor = new AcpxStepExecutor({
  cwd,
  agent,
  ...(model === undefined ? {} : { model }),
  stateDir,
  runtimeFactory: async (input) => {
    const runtime = await createAcpxRuntime(input);
    return {
      ensureSession: (args) => runtime.ensureSession(args),
      setModel: (args) => runtime.setModel(args),
      setMode: (args) => runtime.setMode(args),
      shutdown: () => runtime.shutdown(),
      startTurn: (args) => {
        turns += 1;
        return runtime.startTurn(args);
      },
    };
  },
});

const started = Date.now();
let outcome;
try {
  const result = await executor.runAgentStep(request, AbortSignal.timeout(240_000));
  outcome = { finalValue: result.output };
} catch (error) {
  outcome = { error: error instanceof Error ? error.message : String(error) };
}
await new Promise((resolve) => setTimeout(resolve, 2_000));
const left = processes().filter((line) => !before.has(line.split(" ")[0]));
console.log(
  JSON.stringify({
    agent,
    model,
    ms: Date.now() - started,
    turns,
    remindersUsed: Math.max(turns - 1, 0),
    submissions,
    ...outcome,
    deniedFileExists: fs.existsSync(deniedFile),
    toolActivity: activity.filter((body) => JSON.stringify(body).match(/tool/i)),
    processesLeft: left,
    stateDir,
  }),
);
const passed =
  outcome.error === undefined &&
  submissions.length >= 2 &&
  !fs.existsSync(deniedFile) &&
  left.length === 0;
process.exit(passed ? 0 : 1);
