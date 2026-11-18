import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { action, agent, compute, defineWorkflow, manualEffect } from "@osolmaz/pi-workflows";
import { digest, parseModel, parsePackets, parseReviewBound } from "./lib/landing-contracts.mjs";

const taskWorkflow = fileURLToPath(new URL("./lib/task-run.workflow.ts", import.meta.url));
const evalWorkflow = fileURLToPath(new URL("./acceptance-checks.workflow.ts", import.meta.url));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export default defineWorkflow({
  source: import.meta.url,
  name: "launch-landing",
  title: "Launch three approved task workflows + independent checks",
  input: (raw) => {
    const v = raw as any;
    if (!v || !path.isAbsolute(v.approvedFile) || !/^[a-f0-9]{64}$/.test(v.approvedDigest))
      throw new Error("Need approvedFile and exact approvedDigest from prepare-landing");
    return {
      approvedFile: v.approvedFile,
      approvedDigest: v.approvedDigest,
    };
  },
  startAt: "prepare_workspaces",
  maxSteps: 6,
  exits: { finished: { from: "handoff" } },
  nodes: {
    prepare_workspaces: action({
      effect: manualEffect("landing.workspaces"),
      run: async ({ input, state }) => {
        const v = input as any,
          b = JSON.parse(readFileSync(v.approvedFile, "utf8"));
        if (
          digest(b) !== v.approvedDigest ||
          b.schema !== "grok-landing.approved.v1" ||
          b.approval?.choice !== "approve"
        )
          throw new Error("Approved packet artifact changed or lacks approval");
        // The landing parent enters this composition directly from its protected packet gate.
        const packets = parsePackets(b.packets),
          reviewer = parseModel(b.reviewer),
          reviewRounds = parseReviewBound(b.reviewRounds);
        if (git(b.cwd, "rev-parse", "main") !== b.base)
          throw new Error("Main changed since packet approval; re-prepare instead of guessing");
        const dir = path.join(b.cwd, ".pi", "lane", state.runId);
        mkdirSync(dir, { recursive: true });
        const jobs = packets.map((packet) => {
          const cwd = path.join(dir, "worktrees", packet.id),
            branch = `landing/${state.runId}/${packet.id}`;
          mkdirSync(path.dirname(cwd), { recursive: true });
          git(b.cwd, "worktree", "add", "-b", branch, cwd, b.base);
          const inputFile = path.join(dir, `${packet.id}-input.json`),
            output = path.join(dir, `${packet.id}-result.json`);
          writeFileSync(
            inputFile,
            JSON.stringify({ cwd, packet, reviewer, reviewRounds }, null, 2),
            { flag: "wx" },
          );
          return {
            id: packet.id,
            cwd,
            branch,
            inputFile,
            output,
            model: packet.builder,
            workflow: taskWorkflow,
          };
        });
        const evalInput = {
          cwd: b.cwd,
          output: path.join(dir, "acceptance-result.json"),
          goal: b.goal,
          goals: packets.map(({ id, goal, acceptance }) => ({ id, goal, acceptance })),
          model: parseModel(b.evaluator),
        };
        const integration = {
          cwd: b.cwd,
          base: b.base,
          goal: b.goal,
          packets,
          reviewer,
          reviewRounds,
          delivery: b.delivery,
          resultFiles: jobs.map((j) => j.output),
          acceptanceFile: evalInput.output,
          sourceRunId: state.runId,
        };
        const manifest = path.join(dir, "integration-input.json");
        writeFileSync(manifest, JSON.stringify(integration, null, 2), { flag: "wx" });
        return { jobs, evalInput, evalWorkflow, integrationInput: manifest };
      },
    }),
    launch: agent({
      timeoutMs: null,
      allowedTools: ["subagent", "read", "rex_finish"],
      prompt: ({ outputs }) => {
        const p = outputs.prepare_workspaces as any;
        return [
          "Launch exactly four subagents with fork:false in visible Rex tabs: the three builders and the independent acceptance designer below. Use each exact provider/model:thinking; never substitute. No per-agent turn quota. Dispatch all four before waiting; do not do their work yourself.",
          "Use subagent with cwd, name, model and task from each assignment. Each starts its own actual Pi Workflow. End your turn and let automatic result messages arrive. No polling or duplicate dispatch. A session-created or workflow-started message is NOT a completed task; do not close a worker until its workflow has a terminal result and its handoff file exists. Keep waiting for all four terminal results before submitting this step; finish completed agents with rex_finish after reading their handoffs.",
          ...p.jobs.map((j: any) =>
            JSON.stringify({
              id: j.id,
              cwd: j.cwd,
              model: `${j.model.provider}/${j.model.model}:${j.model.thinking}`,
              name: `landing-${j.id}`,
              task: `Start workflow ${j.workflow} with input ${JSON.stringify({ inputFile: j.inputFile, output: j.output })}. End your turn after start; follow the delivered contracts. Do not start a second workflow. Your assignment and review feedback remain in this feature session.`,
            }),
          ),
          JSON.stringify({
            id: "acceptance-checks",
            cwd: p.evalInput.cwd,
            model: `${p.evalInput.model.provider}/${p.evalInput.model.model}:${p.evalInput.model.thinking}`,
            name: "landing-acceptance",
            task: `Start workflow ${p.evalWorkflow} with input ${JSON.stringify(p.evalInput)}. End your turn after start; follow its contracts. Do not inspect builder reports or patches.`,
          }),
          `Read the three result files and ${p.evalInput.output} after their terminal completion messages. Submit {ok:true} only if all features report status:'ready' and acceptance reports status:'designed'. Otherwise submit {ok:false,reason:'specific failed or blocked task and saved evidence'}. An interrupted, failed, unavailable or missing result is not success. Do not restart agents or expand their assignments. The parent graph joins here and continues into integration automatically.`,
        ].join("\n");
      },
      expectedOutput: "{ok:boolean,reason?:string}",
      validate: (raw, { outputs }) => {
        const v = raw as any, p = outputs.prepare_workspaces as any;
        if (typeof v?.ok !== "boolean") throw new Error("Need explicit joined outcome");
        if (!v.ok) {
          if (!v.reason?.trim()) throw new Error("Explain the blocked task");
          return v;
        }
        for (const j of p.jobs) {
          const h = JSON.parse(readFileSync(j.output, "utf8"));
          if (h.status !== "ready" || h.task !== j.id) throw new Error(`Task ${j.id} is not ready`);
        }
        if (JSON.parse(readFileSync(p.evalInput.output, "utf8")).status !== "designed")
          throw new Error("Independent acceptance design is not complete");
        return v;
      },
    }),
    handoff: compute({
      run: ({ outputs }) => ({
        ok: (outputs.launch as any).ok,
        result: outputs.launch,
        integrationInput: (outputs.prepare_workspaces as any).integrationInput,
      }),
    }),
  },
  edges: [
    { from: "prepare_workspaces", to: "launch" },
    { from: "launch", to: "handoff" },
  ],
});
