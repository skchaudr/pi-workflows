import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { WorkflowServer } from "../src/server/server.js";
import { ServerStateStore } from "../src/server/state.js";
import { makeTempDir, reportBranch, waitUntil } from "./helpers.js";

const ORIGIN_SESSION = "non-pi-frontend";
const RUN_ID = "non-pi-coordinator-run";

async function writeAgentGateAgentWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "agent-gate-agent.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import {
  agent,
  choice,
  compute,
  defineHumanChoices,
  defineWorkflow,
  humanDecision,
  humanDecisionEdge,
} from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});
export default defineWorkflow({
  name: "non-pi-agent-gate-agent",
  startAt: "first",
  nodes: {
    first: agent({ prompt: () => "Return the first result." }),
    gate: humanDecision({
      audience: "operator",
      choices,
      request: () => ({
        title: "Continue?",
        subject: { task: "non-pi" },
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Choose whether to continue.",
          blocks: [],
        },
      }),
    }),
    second: agent({ prompt: () => "Return the second result." }),
    done: compute({ run: ({ outputs }) => ({ first: outputs.first, second: outputs.second }) }),
    stopped: compute({ run: () => ({ stopped: true }) }),
  },
  edges: [
    { from: "first", to: "gate" },
    humanDecisionEdge({
      from: "gate",
      choices,
      cases: { continue: "second", stop: "stopped" },
    }),
    { from: "second", to: "done" },
  ],
});\n`,
  );
  return workflowPath;
}

type PendingInteraction = { requestId: string; kind: string; runId: string; revision: number };

describe("non-Pi workflow coordinator", () => {
  it("a non-Pi client can coordinate an interactive run through a gate in one run", async () => {
    const cwd = await makeTempDir("non-pi-project");
    const databasePath = path.join(await makeTempDir("non-pi-state"), "state.sqlite");
    const workflowPath = await writeAgentGateAgentWorkflow(cwd);
    const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "non-pi-frontend-client" });
    await server.start();
    try {
      // C1: any string works as the origin session of an interactive run.
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
          input: {},
          launchOptions: {},
          originSessionId: ORIGIN_SESSION,
          executionMode: "interactive",
        },
      });
      expect(started.outcome).toBe("accepted");

      // C2: claim the coordinator role with a plain session watch, then report
      // the branch. A non-Pi client holds no Pi session entries, so it reports
      // that it holds no workflow message yet.
      let pending: PendingInteraction | null = null;
      let epoch: string | null = null;
      const unsubscribe = await client.watchSession(
        ORIGIN_SESSION,
        (event) => {
          if (event.event !== "session_snapshot") return;
          const view = event.payload as {
            interaction?: PendingInteraction | null;
            coordinatorEpoch?: string | null;
          };
          pending = view.interaction ?? null;
          epoch = view.coordinatorEpoch ?? null;
        },
        { subscriptionId: "non-pi-session-watch", coordinator: true },
      );
      try {
        await waitUntil(() => epoch !== null, 30_000);
        const authority = {
          targetSessionId: ORIGIN_SESSION,
          coordinatorEpoch: epoch as unknown as string,
        };
        const reported = await reportBranch(client, authority, {
          workflowMessageId: null,
          piSessionEntryId: null,
          isIdle: true,
          hasPendingMessages: false,
        });
        expect(reported.outcome).toBe("accepted");

        const nextInteraction = async (kind: string): Promise<PendingInteraction> => {
          await waitUntil(() => pending !== null && pending.kind === kind, 30_000);
          return pending as unknown as PendingInteraction;
        };

        // C3: the first agent step arrives as a pending interaction and a canned
        // result is submitted for it.
        const first = await nextInteraction("agent");
        expect(first.runId).toBe(RUN_ID);
        const firstSubmit = await client.request({
          operation: "interaction.submit",
          idempotencyKey: "non-pi-first",
          runId: first.runId,
          expectedRevision: first.revision,
          payload: {
            ...authority,
            requestId: first.requestId,
            submissionId: "non-pi-first",
            value: { output: { answer: "first" } },
          },
        });
        expect(firstSubmit.outcome).toBe("accepted");

        // C4: the human gate arrives and is answered.
        const gate = await nextInteraction("decision");
        expect(gate.runId).toBe(RUN_ID);
        const answered = await client.request({
          operation: "decision.answer",
          idempotencyKey: "non-pi-gate",
          runId: gate.runId,
          expectedRevision: gate.revision,
          payload: {
            ...authority,
            requestId: gate.requestId,
            submissionId: "non-pi-gate",
            response: { choice: "continue" },
          },
        });
        expect(answered.outcome).toBe("accepted");

        // C3 again: the second agent step in the same run.
        await waitUntil(
          () =>
            pending !== null && pending.kind === "agent" && pending.requestId !== first.requestId,
          30_000,
        );
        const second = pending as unknown as PendingInteraction;
        expect(second.runId).toBe(RUN_ID);
        const secondSubmit = await client.request({
          operation: "interaction.submit",
          idempotencyKey: "non-pi-second",
          runId: second.runId,
          expectedRevision: second.revision,
          payload: {
            ...authority,
            requestId: second.requestId,
            submissionId: "non-pi-second",
            value: { output: { answer: "second" } },
          },
        });
        expect(secondSubmit.outcome).toBe("accepted");
      } finally {
        await unsubscribe();
      }

      // C5: the same run reaches completed, and the gate answer is recorded.
      await waitUntil(() => {
        const observed = new ServerStateStore(databasePath, { readOnly: true });
        try {
          const row = observed.state.connection
            .prepare("SELECT status FROM runs WHERE run_id = ?")
            .get(RUN_ID) as { status: string } | undefined;
          if (row?.status === "failed") throw new Error("run failed");
          return row?.status === "completed";
        } finally {
          observed.close();
        }
      }, 30_000);
      const observed = new ServerStateStore(databasePath, { readOnly: true });
      try {
        const runs = observed.state.connection.prepare("SELECT run_id FROM runs").all() as Array<{
          run_id: string;
        }>;
        expect(runs.map((run) => run.run_id)).toEqual([RUN_ID]);
        const submissions = observed.state.connection
          .prepare("SELECT submission_id, outcome FROM interactive_submissions")
          .all() as Array<{ submission_id: string; outcome: string }>;
        expect(submissions.map((row) => row.submission_id).sort()).toEqual([
          "non-pi-first",
          "non-pi-gate",
          "non-pi-second",
        ]);
        expect(submissions.every((row) => row.outcome === "accepted")).toBe(true);
      } finally {
        observed.close();
      }
    } finally {
      await client.close();
      await server.stop();
    }
  }, 90_000);
});
