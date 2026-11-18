// Lane: one step (AGENTS.md) -> scout -> brief review -> build -> gate -> build review -> commit.
// Spec: docs/pi-lane/SPEC.md. Run it with `/step <path-to-step.md>` (.pi/prompts/step.md).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  action,
  agent,
  checkpoint,
  compute,
  defineWorkflow,
  idempotentEffect,
  manualEffect,
  shell,
  type WorkflowNodeContext,
} from "@osolmaz/pi-workflows";

type LaneInput = { step: string };

type Prep = {
  runId: string;
  dir: string; // absolute .pi/lane/<run-id>
  step: string;
  brief: string;
  briefReview: string;
  gate: string;
  diffPatch: string;
  review: string;
  verify: string;
  gateTimeoutMs: number;
  title: string;
  builder: { agent: string; tool: string; model: string };
};

// Builder adapters (pi-subagents builtins, docs/agents.md "Codex/Claude Code/Cursor CLI profiles").
const BUILDERS: Record<string, { agent: string; tool: string }> = {
  worker: { agent: "lane-worker", tool: "pi" },
  "claude-code-writer": { agent: "claude-code-writer", tool: "claude-code" },
  "codex-exec-writer": { agent: "codex-exec-writer", tool: "codex" },
  "cursor-agent-writer": { agent: "cursor-agent-writer", tool: "cursor-agent" },
};
const DEFAULT_GATE_TIMEOUT_MS = 1_800_000; // placeholder, not measured; override per step with `Timeout-ms:`

const prep = (ctx: WorkflowNodeContext) => ctx.outputs.prepare as Prep;

/** Last capture of `re` (global, multiline) in a file; "missing" when the file or the line is absent. */
function verdictOf(file: string, re: RegExp): string {
  if (!existsSync(file)) return "missing";
  const all = [...readFileSync(file, "utf8").matchAll(re)];
  return all.length ? all[all.length - 1][1] : "missing";
}

/** Current Rex API: role text is explicitly injected, never implicitly loaded. */
function delegate(stage: string, child: string, task: string[], output?: string): string {
  const local = path.resolve(".pi/agents", `${child}.md`);
  const global = path.join(homedir(), ".pi/agent/agents", `${child}.md`);
  const role = existsSync(local) ? readFileSync(local, "utf8") : existsSync(global) ? readFileSync(global, "utf8") : "";
  if (!role) throw new Error(`Role missing: ${child}; no silent substitution`);
  const override = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))?.subagents?.agentOverrides?.[child]?.model : undefined;
  const model = override(".pi/settings.json") ?? override(path.join(homedir(), ".pi/agent/settings.json")) ?? role.match(/^model:[ \t]*(\S+)/m)?.[1];
  if (!model) throw new Error(`Role ${child} needs explicit model`);
  return [
    `Lane stage: ${stage}. Launch exactly one subagent with name:${JSON.stringify(child)}, model:${JSON.stringify(model)}, fork:false and task containing this entire assignment. No tool-call quota or arbitrary agent deadline. Confirm actual model; never substitute.`,
    "Role tool restrictions are trusted task instructions, not enforced child isolation.",
    role, readFileSync(".pi/agents/delivery-policy.md", "utf8"), ...task,
    output ? `Return the complete document in your final response; the parent will save it to ${output}. Do not write the report yourself.` : "Return changed paths and outcome.",
    'IMMEDIATELY submit {id,artifacts,blocked:""} from the launch receipt to complete dispatch in this turn. Do not wait for the result or merely end your turn. Launch failure submits {id:"",artifacts:"",blocked:"reason"}. Never duplicate an uncertain dispatch.',
  ].join("\n");
}
const childStages = ["scout", "brief_review", "scout_retry", "build", "build_review", "fix"];
// Split each asynchronous handoff into completed dispatch, ordinary durable wait and result collection.
function childStage(stage: string, prompt: (ctx: WorkflowNodeContext) => string, report?: (ctx: WorkflowNodeContext) => string) {
  return {
    [`${stage}_dispatch`]: agent({
      timeoutMs: null, allowedTools: ["subagent"], prompt,
      expectedOutput: "{id:string,artifacts:string,blocked:string}",
      validate: (v: any) => {
        if (typeof v?.blocked !== "string" || (!v.blocked && (!/^[a-f0-9-]{36}$/.test(v.id) || !path.isAbsolute(v.artifacts)))) throw new Error("Need actual dispatch receipt or launch blocker");
        return { ...v, route: v.blocked ? "collect" : "wait" };
      },
    }),
    [`${stage}_wait`]: checkpoint({
      summary: `Await ${stage} automatic Rex completion`,
      run: ({ outputs }: WorkflowNodeContext) => ({ dispatch: outputs[`${stage}_dispatch`], instructions: "No polling/duplicate launch. Automatic result for this exact id permits ordinary checkpoint answer {id}; collection follows. Cancellation stops continuation." }),
    }),
    [`${stage}_collect`]: agent({
      timeoutMs: null, allowedTools: ["read", "rex_finish"],
      prompt: (ctx: WorkflowNodeContext) => `Collect actual result for ${JSON.stringify(ctx.outputs[`${stage}_dispatch`])}. If dispatch failed, submit {ok:false,note:'reason'}. Otherwise read result.json at that artifacts path, rex_finish the completed child, then submit {ok:true} for completed work (including review recommending BLOCK), or {ok:false,note:'reason'} for failed/unavailable work. Do not launch/poll or fabricate reports. Workflow-owned validation saves the actual report.`,
      expectedOutput: '{ok:boolean,note?:string}',
      validate: (v: any, ctx: WorkflowNodeContext) => {
        const dispatch = ctx.outputs[`${stage}_dispatch`] as any;
        if (typeof v?.ok !== "boolean") throw new Error("Need completion outcome");
        if (dispatch.blocked) return { ok: false, note: dispatch.blocked };
        if ((ctx.outputs[`${stage}_wait`] as any)?.id !== dispatch.id) throw new Error("Wrong child completion id");
        const run = JSON.parse(readFileSync(path.join(dispatch.artifacts, "run.json"), "utf8"));
        const result = JSON.parse(readFileSync(path.join(dispatch.artifacts, "result.json"), "utf8"));
        if (run.id !== dispatch.id || result.status !== "completed" || typeof result.text !== "string") return { ok: false, note: "Child result missing/failed/mismatched" };
        return v;
      },
    }),
    [stage]: action({
      effect: manualEffect(`lane.${stage}-handoff`),
      run: (ctx: WorkflowNodeContext) => {
        const value = ctx.outputs[`${stage}_collect`] as any;
        if (value.ok && report) {
          const dispatch = ctx.outputs[`${stage}_dispatch`] as any;
          const result = JSON.parse(readFileSync(path.join(dispatch.artifacts, "result.json"), "utf8"));
          writeFileSync(report(ctx), result.text);
        }
        return value;
      },
    }),
  };
}
const disposition = (artifact: (ctx: WorkflowNodeContext) => string) => agent({
  timeoutMs: null, allowedTools: ["read", "grep", "find", "ls"],
  prompt: (ctx) => `${readFileSync(".pi/agents/delivery-policy.md", "utf8")}\nRead ${artifact(ctx)} and approved step ${prep(ctx).step}. Accept/reject/defer every claim with reasons. blockers contains only accepted material delivery blockers, each with claim (matching an accepted disposition), condition, evidence, consequence and beforeDelivery. Missing/unavailable review means available:false. Notes/unknowns do not authorize repair. No edits or commands.`,
  expectedOutput: "{available:boolean,dispositions:[{claim:string,decision:'accept'|'reject'|'defer',reason:string}],blockers:[{claim:string,condition:string,evidence:string,consequence:string,beforeDelivery:string}]}",
  validate: (v: any) => {
    if (typeof v?.available !== "boolean" || !Array.isArray(v.dispositions) || !Array.isArray(v.blockers)) throw new Error("Need review disposition");
    for (const d of v.dispositions) if (!["accept", "reject", "defer"].includes(d.decision) || !d.claim?.trim() || !d.reason?.trim()) throw new Error("Need reasoned dispositions");
    for (const f of v.blockers) {
      for (const k of ["claim", "condition", "evidence", "consequence", "beforeDelivery"]) if (typeof f[k] !== "string" || !f[k].trim()) throw new Error("Blocker needs material evidence");
      if (!v.dispositions.some((d: any) => d.claim === f.claim && d.decision === "accept")) throw new Error("Repair requires an accepted claim");
    }
    return v;
  },
});

const scoutPrompt = (ctx: WorkflowNodeContext, retry: boolean) => {
  const p = prep(ctx);
  return delegate(retry ? "scout (retry)" : "scout", "lane-scout", [
    `LANE scout ${p.runId}`,
    `step: ${p.step}`,
    `brief: ${p.brief}`,
    ...(retry ? [`Previous review is evidence, NOT repair authority: ${p.briefReview}`, `Amend only accepted material blockers: ${JSON.stringify(ctx.outputs.brief_disposition)}`] : []),
  ], p.brief);
};

const builderPrompt = (ctx: WorkflowNodeContext, fix: boolean) => {
  const p = prep(ctx);
  return delegate(fix ? "fix" : "build", p.builder.agent, [
    `LANE ${fix ? "fix" : "build"} ${p.runId}`,
    `step: ${p.step}`,
    `brief: ${p.brief}`,
    ...(fix ? [`review: ${p.review} (context only, not repair authority)`, `gate: ${p.gate}`, `Only fix failed approved checks and accepted material blockers: ${JSON.stringify(ctx.outputs.build_disposition ?? null)}. Do not fix rejected/deferred/nonblocking review notes.`] : []),
  ]);
};

const stop = (reason: string) => (ctx: WorkflowNodeContext) => {
  const p = prep(ctx);
  return { reason, run: p.dir, brief: p.brief, briefReview: p.briefReview, gate: p.gate, diff: p.diffPatch, review: p.review };
};

export default defineWorkflow<LaneInput>({
  name: "step",
  input: (value): LaneInput => {
    const v = (value ?? {}) as { step?: unknown; task?: unknown };
    const step = typeof v.step === "string" ? v.step : v.task; // `/workflow step <path>` arrives as {task}
    if (typeof step !== "string" || step.trim() === "") throw new Error('input needs {"step": "<path-to-step.md>"}');
    return { step: step.trim() };
  },
  title: ({ input }) => `step: ${path.basename((input as LaneInput).step)}`,
  startAt: "prepare",
  nodes: {
    // Clean-tree check, run dir, step copy, header parse (Verify / Timeout-ms / Builder).
    prepare: action({
      effect: idempotentEffect("lane.prepare"),
      run: ({ input, state }): Prep => {
        const src = path.resolve(process.cwd(), (input as LaneInput).step);
        if (!existsSync(src)) throw new Error(`step file not found: ${src}`);
        const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
        if (dirty) throw new Error(`working tree not clean (commit or stash first):\n${dirty.slice(0, 1000)}`);
        const dir = path.resolve(process.cwd(), ".pi/lane", state.runId);
        mkdirSync(dir, { recursive: true });
        const step = path.join(dir, "step.md");
        copyFileSync(src, step);
        const text = readFileSync(step, "utf8");
        const header = (key: string) => text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"))?.[1].trim();
        const verify = header("Verify")?.replace(/^`(.*)`$/, "$1");
        if (!verify) throw new Error("step file has no `Verify: <command>` line");
        const builderKey = header("Builder") ?? "worker";
        const b = BUILDERS[builderKey];
        if (!b) throw new Error(`Builder must be one of ${Object.keys(BUILDERS).join(", ")}`);
        // Trailer model: lane-worker's effective model (project settings override, then user, then frontmatter); external CLIs use their own default.
        let model = "default";
        if (builderKey === "worker") {
          const override = (file: string): string | undefined =>
            existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))?.subagents?.agentOverrides?.["lane-worker"]?.model : undefined;
          model =
            override(".pi/settings.json") ??
            override(path.join(homedir(), ".pi/agent/settings.json")) ??
            readFileSync(".pi/agents/lane-worker.md", "utf8").match(/^model:[ \t]*(\S+)/m)?.[1] ??
            "default";
        }
        return {
          runId: state.runId,
          dir,
          step,
          brief: path.join(dir, "brief.md"),
          briefReview: path.join(dir, "brief-review.md"),
          gate: path.join(dir, "gate.json"),
          diffPatch: path.join(dir, "diff.patch"),
          review: path.join(dir, "review.md"),
          verify,
          gateTimeoutMs: Number(header("Timeout-ms")) || DEFAULT_GATE_TIMEOUT_MS,
          title: text.match(/^#\s+(.+)$/m)?.[1].trim() ?? path.basename((input as LaneInput).step),
          builder: { ...b, model },
        };
      },
    }),

    // Stage 1: scout. Writes brief.md (path in `output`), lists unconfirmed premises inside it.
    ...childStage("scout", (ctx) => scoutPrompt(ctx, false), (ctx) => prep(ctx).brief),

    // Stage 2: brief review on another model. Verdict is read from brief-review.md, not relayed.
    ...childStage("brief_review", (ctx) => {
        const p = prep(ctx);
        return delegate("brief review", "lane-brief-reviewer", [
          `LANE brief-review ${p.runId}`,
          `step: ${p.step}`,
          `brief: ${p.brief}`,
        ], p.briefReview);
      }, (ctx) => prep(ctx).briefReview),
    brief_disposition: disposition((ctx) => prep(ctx).briefReview),
    brief_route: compute({
      run: (ctx) => {
        const p = prep(ctx);
        const v = verdictOf(p.briefReview, /^Brief verdict:[ \t]*(OK|BLOCK)[ \t]*$/gm);
        const hasBrief = existsSync(p.brief) && statSync(p.brief).size > 0;
        const judgment = ctx.outputs.brief_disposition as { available: boolean; blockers: unknown[] };
        const available = judgment.available && (ctx.outputs.brief_review as { ok: boolean }).ok && hasBrief;
        const route = !available ? "stop" : judgment.blockers.length === 0 ? "build" : ctx.outputs.scout_retry === undefined ? "retry" : "stop";
        return { route, verdict: v, hasBrief };
      },
    }),
    ...childStage("scout_retry", (ctx) => scoutPrompt(ctx, true), (ctx) => prep(ctx).brief),
    brief_stop: checkpoint({ summary: "brief blocked twice; a human decides", run: stop("brief review BLOCK after one retry") }),

    // Stage 3: build.
    ...childStage("build", (ctx) => builderPrompt(ctx, false)),

    // A builder that reports BLOCKED or failed skips the gate: no wasted verify run.
    build_route: compute({
      run: (ctx) => {
        const last = (ctx.outputs.fix ?? ctx.outputs.build) as { ok?: boolean; note?: string };
        return { route: last.ok === false ? "stop" : "gate", ...(last.note !== undefined ? { note: last.note } : {}) };
      },
    }),

    // Stage 4: gate. Verify command runs in a process group; the node's timeout kills the whole tree.
    gate: shell({
      effect: idempotentEffect("lane.gate"),
      timeoutMs: (ctx) => prep(ctx).gateTimeoutMs + 60_000,
      exec: (ctx) => {
        const p = prep(ctx);
        return {
          command: "sh",
          args: ["-c", 'sh .pi/gate.sh "$1" > "$2"; cat "$2"', "lane-gate", p.verify, p.gate],
          timeoutMs: p.gateTimeoutMs,
          maxOutputChars: 20_000,
        };
      },
      parse: (r) => JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { ok: boolean; output: string },
    }),
    // Writes diff.patch for the reviewer and reports its size; the tree was clean at prepare, so this is the step's diff.
    diff: shell({
      effect: idempotentEffect("lane.diff"),
      exec: (ctx) => ({
        command: "sh",
        args: [
          "-c",
          'git add -N . && git diff -- . ":!.pi" > "$1" && printf \'{"chars":%s}\\n\' "$(wc -c < "$1" | tr -d " ")"',
          "lane-diff",
          prep(ctx).diffPatch,
        ],
        timeoutMs: 60_000,
      }),
      parse: (r) => JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { chars: number },
    }),
    gate_route: compute({
      run: (ctx) => {
        const g = ctx.outputs.gate as { ok: boolean };
        const d = ctx.outputs.diff as { chars: number };
        const route = g.ok && d.chars > 0 ? "review" : ctx.outputs.fix === undefined ? "fix" : "stop";
        return { route, gateOk: g.ok, diffChars: d.chars };
      },
    }),

    // Stage 5: build review on another model; reads step, brief, diff.patch, gate.json by path.
    ...childStage("build_review", (ctx) => {
        const p = prep(ctx);
        return delegate("build review", "lane-build-reviewer", [
          `LANE build-review ${p.runId}`,
          `step: ${p.step}`,
          `brief: ${p.brief}`,
          `diff: ${p.diffPatch}`,
          `gate: ${p.gate}`,
        ], p.review);
      }, (ctx) => prep(ctx).review),

    build_disposition: disposition((ctx) => prep(ctx).review),
    // Raw verdict is retained as evidence; only coordinator-accepted material blockers trigger review repair.
    complete: compute({
      run: (ctx) => {
        const p = prep(ctx);
        const g = ctx.outputs.gate as { ok: boolean };
        const d = ctx.outputs.diff as { chars: number };
        const verdict = verdictOf(p.review, /^Merge verdict:[ \t]*(OK with notes|OK|BLOCK)[ \t]*$/gm);
        const judgment = ctx.outputs.build_disposition as { available: boolean; blockers: unknown[] };
        const available = judgment.available && (ctx.outputs.build_review as { ok: boolean }).ok;
        const ok = available && g.ok === true && d.chars > 0 && judgment.blockers.length === 0;
        const route = !available ? "stop" : ok ? "commit" : ctx.outputs.fix === undefined ? "fix" : "stop";
        return { ok, route, verdict, gateOk: g.ok, diffChars: d.chars };
      },
    }),
    ...childStage("fix", (ctx) => builderPrompt(ctx, true)),
    build_stop: checkpoint({ summary: "gate or build review failed after one fix round; a human decides", run: stop("gate/review not OK after one fix round") }),

    // Commit with the builder's trailer (SPEC-usable: `Co-authored-by: <tool> <model>`).
    commit: shell({
      effect: manualEffect("lane.commit"),
      exec: (ctx) => {
        const p = prep(ctx);
        const verdict = (ctx.outputs.complete as { verdict: string }).verdict;
        return {
          command: "sh",
          args: [
            "-c",
            'git add -A -- . ":!.pi" && git commit -q "$@" && printf \'{"commit":"%s"}\\n\' "$(git rev-parse HEAD)"',
            "lane-commit",
            "-m",
            `lane: ${p.title}`.slice(0, 72),
            "-m",
            `Step: ${(ctx.input as LaneInput).step}\nRun: ${p.runId}\nMerge verdict: ${verdict}`,
            "-m",
            `Co-authored-by: ${p.builder.tool} ${p.builder.model}`,
          ],
          timeoutMs: 60_000,
        };
      },
      parse: (r) => JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { commit: string },
    }),
  },
  edges: [
    ...childStages.flatMap(stage => [
      { from: `${stage}_dispatch`, switch: { on: "$.route", cases: { wait: `${stage}_wait`, collect: `${stage}_collect` } } },
      { from: `${stage}_wait`, to: `${stage}_collect` },
      { from: `${stage}_collect`, to: stage },
    ]),
    { from: "prepare", to: "scout_dispatch" },
    { from: "scout", to: "brief_review_dispatch" },
    { from: "brief_review", to: "brief_disposition" },
    { from: "brief_disposition", to: "brief_route" },
    { from: "brief_route", switch: { on: "$.route", cases: { build: "build_dispatch", retry: "scout_retry_dispatch", stop: "brief_stop" } } },
    { from: "scout_retry", to: "brief_review_dispatch" },
    { from: "build", to: "build_route" },
    { from: "build_route", switch: { on: "$.route", cases: { gate: "gate", stop: "build_stop" } } },
    { from: "gate", switch: { on: "$result.outcome", cases: { ok: "diff", failed: "build_stop", timed_out: "build_stop", cancelled: "build_stop" } } },
    { from: "diff", to: "gate_route" },
    { from: "gate_route", switch: { on: "$.route", cases: { review: "build_review_dispatch", fix: "fix_dispatch", stop: "build_stop" } } },
    { from: "build_review", to: "build_disposition" },
    { from: "build_disposition", to: "complete" },
    { from: "complete", switch: { on: "$.route", cases: { commit: "commit", fix: "fix_dispatch", stop: "build_stop" } } },
    { from: "fix", to: "build_route" },
  ],
});
