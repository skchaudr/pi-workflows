import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import type { ClientEvent } from "../src/client/protocol.js";
import { WorkflowServer } from "../src/server/server.js";
import { ServerStateStore } from "../src/server/state.js";
import { parseStepActivity, STEP_ACTIVITY_SCHEMA } from "../src/state/step-activity.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const RUN_ID = "activity-wire-run";
const SUBSCRIPTION_PREFIX = "activity-watch";

type ActivityEvent = {
  activities: ReturnType<typeof parseStepActivity>[];
  reset: boolean;
};

/**
 * A minimal runner that speaks the real runner protocol: ready handshake, then
 * the scripted activity batches (waiting for trigger files between groups), then
 * a clean exit. Its messages use the same wire shape the real
 * `workflow-runner-entry` sends for `activity.publish`.
 */
const FAKE_ACTIVITY_RUNNER = `import fs from "node:fs";
import readline from "node:readline";

const launch = JSON.parse(
  Buffer.from(process.env.PI_WORKFLOWS_WORKFLOW_RUNNER_LAUNCH, "base64url").toString("utf8"),
);
const script = JSON.parse(fs.readFileSync(process.env.FAKE_ACTIVITY_SCRIPT, "utf8"));

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort().filter((key) => value[key] !== undefined);
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}

let counter = 0;
function message(kind, operation, payload) {
  counter += 1;
  return {
    schema: "pi-workflows.runner-message.v1",
    launchSchema: "pi-workflows.runner-launch.v1",
    messageId: "fake-" + counter,
    kind,
    operation,
    runId: launch.runId,
    generation: launch.generation,
    runnerEpoch: launch.runnerEpoch,
    expectedRevision: 0,
    payload,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file) {
  while (!fs.existsSync(file)) await delay(20);
}

function send(activity) {
  process.stdout.write(canonical(message("runner.progress", "activity.publish", activity)) + "\\n");
}

// The response reader keeps the pipe drained; only the ready answer is awaited.
const responses = readline.createInterface({ input: process.stdin });
const ready = new Promise((resolve) => {
  responses.once("line", () => resolve(undefined));
});
responses.on("line", () => undefined);
process.stdout.write(canonical(message("runner.ready", "runner.ready", {})) + "\\n");
await ready;

for (const step of script) {
  if (step.waitFile !== undefined) await waitForFile(step.waitFile);
  if (step.activity !== undefined) {
    for (const batch of step.activity) {
      send({ nodeId: batch.nodeId, attemptId: batch.attemptId, bodies: batch.bodies });
      await delay(5);
    }
  }
}
process.stdout.write(canonical(message("runner.exiting", "runner.exiting", { status: "done" })) + "\\n");
process.exit(0);
`;

type ScriptedBatch = { nodeId: string; attemptId: string; bodies: unknown[] };
type RunnerScriptStep = { activity?: ScriptedBatch[]; waitFile?: string };

function collectActivity(
  events: ActivityEvent[],
  seen: (payload: unknown) => void = () => undefined,
) {
  return (event: ClientEvent): void => {
    if (event.event !== "step_activity") return;
    const payload = event.payload as { activities?: unknown[]; reset?: boolean };
    const activities = (payload.activities ?? []).map((value) => parseStepActivity(value));
    seen(payload);
    events.push({ activities, reset: payload.reset === true });
  };
}

async function writeDemoWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "activity-demo.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "activity-demo",
  startAt: "work",
  nodes: { work: compute({ run: ({ input }) => ({ input }) }) },
  edges: [],
});
`,
  );
  return workflowPath;
}

describe("live step activity over the client protocol", () => {
  it("delivers runner activity to watchers in seq order, without recording or revising", async () => {
    const cwd = await makeTempDir("activity-wire-project");
    const stateRoot = await makeTempDir("activity-wire-state");
    const control = await makeTempDir("activity-wire-control");
    const databasePath = path.join(stateRoot, "state.sqlite");
    const workflowPath = await writeDemoWorkflow(cwd);
    const runnerPath = path.join(control, "fake-activity-runner.mjs");
    const scriptPath = path.join(control, "script.json");
    const goFile = path.join(control, "go");
    const runnerDoneFile = path.join(control, "runner-done");
    await fs.writeFile(runnerPath, FAKE_ACTIVITY_RUNNER);

    // One oversized burst: 24 text bodies of 30,000 characters each, about
    // 720 KB in total, so the server must split it across frames.
    const burstBodies = Array.from({ length: 24 }, (_, index) => ({
      kind: "text",
      text: "b".repeat(30_000) + String(index),
    }));
    const script: RunnerScriptStep[] = [
      {
        activity: [
          {
            nodeId: "work",
            attemptId: "att-1",
            bodies: [
              { kind: "text", text: "first chunk " },
              { kind: "text", text: "second chunk" },
              { kind: "status", text: "still working" },
            ],
          },
          {
            nodeId: "work",
            attemptId: "att-1",
            bodies: [
              {
                kind: "tool",
                text: "Read README.md",
                tool: {
                  toolCallId: "call-1",
                  title: "Read",
                  status: "in_progress",
                  kind: "read",
                  input: { path: "README.md" },
                },
              },
            ],
          },
        ],
      },
      { waitFile: goFile },
      { activity: [{ nodeId: "work", attemptId: "att-1", bodies: burstBodies }] },
      { waitFile: path.join(control, "runner-done") },
    ];
    await fs.writeFile(scriptPath, JSON.stringify(script));

    const server = new WorkflowServer({
      databasePath,
      claimPollMs: 10,
      runnerEntryPath: runnerPath,
      env: { FAKE_ACTIVITY_SCRIPT: scriptPath },
    });
    const client = new WorkflowClient({ databasePath });
    await server.start();
    const everything: ActivityEvent[] = [];
    try {
      const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
      const started = await client.request({
        operation: "run.start",
        runId: RUN_ID,
        payload: {
          projectPath: cwd,
          workflowName: resolved.workflowName,
          workflowSourceRef: resolved.workflowSourceRef,
          workflowSource: resolved.workflowSource,
          definitionDigest: resolved.definitionDigest,
          definitionSnapshot: resolved.definitionSnapshot,
          input: { value: 1 },
          launchOptions: {},
          originSessionId: "activity-wire-session",
          executionMode: "headless",
        },
      });
      expect(started.outcome).toBe("accepted");

      // The primary watcher sees everything the run publishes, live or replay.
      const stopWatching = await client.watchRunActivity(RUN_ID, collectActivity(everything), {
        subscriptionId: `${SUBSCRIPTION_PREFIX}-all`,
      });
      try {
        await waitUntil(() => everything.flatMap((event) => event.activities).length >= 4, 30_000);
        const live = everything.flatMap((event) => event.activities);
        expect(live.map((activity) => activity.seq)).toEqual([1, 2, 3, 4]);
        expect(live[0]).toMatchObject({
          schema: STEP_ACTIVITY_SCHEMA,
          runId: RUN_ID,
          nodeId: "work",
          attemptId: "att-1",
          kind: "text",
          text: "first chunk ",
        });
        expect(live[2]).toMatchObject({ kind: "status", text: "still working" });
        expect(live[3]).toMatchObject({
          kind: "tool",
          tool: { toolCallId: "call-1", status: "in_progress", kind: "read" },
        });

        // The runner's activity side channel never touches the run revision.
        const beforeBurst = await client.getRun(RUN_ID);

        // A late watcher still gets the remembered records as a replay.
        const replayed: ActivityEvent[] = [];
        const stopReplay = await client.watchRunActivity(RUN_ID, collectActivity(replayed), {
          subscriptionId: `${SUBSCRIPTION_PREFIX}-late`,
          afterSeq: 2,
        });
        await waitUntil(() => replayed.flatMap((event) => event.activities).length >= 2, 15_000);
        expect(replayed.flatMap((event) => event.activities).map((a) => a.seq)).toEqual([3, 4]);
        for (const event of replayed) expect(event.reset).toBe(false);
        await stopReplay();

        // An unwatched watcher stops receiving before the burst arrives.
        const stopped: ActivityEvent[] = [];
        const stopUnwatched = await client.watchRunActivity(RUN_ID, collectActivity(stopped), {
          subscriptionId: `${SUBSCRIPTION_PREFIX}-stopped`,
        });
        await waitUntil(() => stopped.flatMap((event) => event.activities).length >= 4, 15_000);
        await stopUnwatched();
        await fs.writeFile(goFile, "go");

        await waitUntil(() => everything.flatMap((event) => event.activities).length >= 28, 30_000);
        const all = everything.flatMap((event) => event.activities);
        expect(all.map((activity) => activity.seq)).toEqual(
          Array.from({ length: 28 }, (_, index) => index + 1),
        );
        // The oversized burst was split across several step_activity frames.
        const burstEvents = everything.filter((event) =>
          event.activities.some((activity) => activity.seq >= 5),
        );
        expect(burstEvents.length).toBeGreaterThan(1);
        expect(
          burstEvents
            .flatMap((event) => event.activities.map((activity) => activity.seq))
            .join(","),
        ).toEqual(Array.from({ length: 24 }, (_, index) => index + 5).join(","));
        // Text survives the split whole: the chunks concatenate back in order.
        const burstText = burstEvents
          .flatMap((event) => event.activities.filter((activity) => activity.seq >= 5))
          .map((activity) => activity.text)
          .join("");
        expect(burstText).toEqual(burstBodies.map((body) => body.text).join(""));
        // The unwatched watcher got nothing after its unwatch.
        expect(stopped.flatMap((event) => event.activities).length).toBe(4);

        // Activity changed neither the run revision nor the recorded messages.
        const afterBurst = await client.getRun(RUN_ID);
        expect(afterBurst?.runRevision).toBe(beforeBurst?.runRevision);
        const state = new ServerStateStore(databasePath, { readOnly: true });
        try {
          const recorded = state.state.connection
            .prepare(
              `SELECT COUNT(*) AS count
               FROM runner_messages m
               JOIN run_runners r ON r.runner_epoch = m.runner_epoch
               WHERE r.run_id = ?`,
            )
            .get(RUN_ID) as { count: number };
          // The only recorded runner message is the ready handshake; none of
          // the activity.publish messages (three batches, 27 bodies) was
          // recorded.
          expect(recorded.count).toBe(1);
        } finally {
          state.close();
        }
      } finally {
        await stopWatching();
      }

      // A watch whose afterSeq is beyond the newest seq gets reset: true and
      // starts from the beginning of what the hub still holds.
      const reset: ActivityEvent[] = [];
      const stopReset = await client.watchRunActivity(RUN_ID, collectActivity(reset), {
        subscriptionId: `${SUBSCRIPTION_PREFIX}-reset`,
        afterSeq: 10_000,
      });
      try {
        await waitUntil(() => reset.length > 0, 15_000);
        expect(reset[0]?.reset).toBe(true);
        expect(reset[0]?.activities[0]?.seq).toBe(1);
        const resetSeqs = reset.flatMap((event) => event.activities.map((a) => a.seq));
        expect(resetSeqs).toEqual(Array.from({ length: 28 }, (_, index) => index + 1));
      } finally {
        await stopReset();
      }

      // Let the parked runner finish and exit cleanly.
      await fs.writeFile(runnerDoneFile, "done");
    } finally {
      await client.close();
      await server.stop();
    }
  }, 120_000);
});
