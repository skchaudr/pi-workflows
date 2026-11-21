#!/usr/bin/env node
// Live proof for AcpxStepExecutor (not part of `npm test`): runs one real step through acpx.
//
//   npm run build
//   node scripts/live-acpx-executor.mjs grok-build
//   node scripts/live-acpx-executor.mjs claude
//
// The model is told to submit 5 first. `accept` rejects it ("answer must be 4"), so the model has to
// correct the output and submit again through the MCP `workflow` tool; the second submission is
// accepted. Prints one JSON line: reminders used, submissions seen, the final accepted value and
// any agent or MCP process still running afterwards. Makes real model calls; keep the prompt tiny.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agent = process.argv[2] ?? "grok-build";
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
const before = new Set(processes().map((line) => line.split(" ")[0]));

let turns = 0;
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
  },
  prompt: [
    "This is a tiny test. Work out 2+2, but FIRST submit the wrong value 5 as the answer.",
    "If the workflow rejects it, read the error and submit the corrected output.",
    "Do not use any tool other than the workflow tool. Do not read or write files.",
    "",
    `Workflow step contract: complete this step by calling the \`workflow\` tool with {"action": "submit", "requestId": "${requestId}", "output": {"answer": <number>}}.`,
    'If the tool reports a validation error, correct the output and call it again. Expected output: a JSON object {"answer": <number>}.',
  ].join("\n"),
  accept: async (output) => {
    submissions.push(output);
    const answer = output?.answer;
    return answer === 4 ? { ok: true, value: output } : { ok: false, error: "answer must be 4" };
  },
};

const executor = new AcpxStepExecutor({
  cwd,
  agent,
  stateDir,
  runtimeFactory: async (input) => {
    const runtime = await createAcpxRuntime(input);
    return {
      ensureSession: (args) => runtime.ensureSession(args),
      setModel: (args) => runtime.setModel(args),
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
    ms: Date.now() - started,
    turns,
    remindersUsed: Math.max(turns - 1, 0),
    submissions,
    ...outcome,
    processesLeft: left,
    stateDir,
  }),
);
process.exit(outcome.error === undefined && left.length === 0 ? 0 : 1);
