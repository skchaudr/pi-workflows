import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { action, agent, checkpoint, choice, compute, defineHumanChoices, defineWorkflow, humanDecision, humanDecisionEdge, manualEffect, textInput } from "@osolmaz/pi-workflows";

type Input = { task: string; handoff: string; authority: string; planner: string; reviewer: string };
type Finding = { id: string; condition: string; evidence: string; consequence: string; beforeDelivery: string };
type Proposal = { summary: string; scope: string; authority: string; models: string; checks: string; stopping: string; nextAction: string; originalDone: boolean; doneEvidence: string[]; source: string };
type Disposition = { id: string; decision: "accept" | "reject" | "defer"; material: boolean; reason: string };
const policy = () => readFileSync(fileURLToPath(new URL("../agents/delivery-policy.md", import.meta.url)), "utf8");
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
export const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export function parseProposal(v: any): Proposal {
  for (const k of ["summary", "scope", "authority", "models", "checks", "stopping", "nextAction", "source"])
    if (!text(v?.[k])) throw new Error(`Proposal needs ${k}`);
  if (typeof v.originalDone !== "boolean" || !Array.isArray(v.doneEvidence) || !v.doneEvidence.every(text)) throw new Error("Need completed-work evidence array and originalDone flag");
  if (v.originalDone && !v.doneEvidence.length) throw new Error("Already-done needs evidence");
  return Object.fromEntries(["summary", "scope", "authority", "models", "checks", "stopping", "nextAction", "originalDone", "doneEvidence", "source"].map(k => [k, v[k]])) as Proposal;
}
export function parseDispositions(v: any, findings: Finding[]): { dispositions: Disposition[]; summary: string } {
  if (!text(v?.summary) || !Array.isArray(v.dispositions) || v.dispositions.length !== findings.length) throw new Error("Disposition every finding exactly once");
  const ids = new Set<string>();
  for (const d of v.dispositions) {
    if (!findings.some(f => f.id === d.id) || ids.has(d.id) || !["accept", "reject", "defer"].includes(d.decision) || typeof d.material !== "boolean" || !text(d.reason)) throw new Error("Invalid disposition");
    // A material claim cannot be silently deferred into approval.
    if (d.decision === "defer" && d.material) throw new Error("Resolve or reject material blocker; do not defer it into approval");
    ids.add(d.id);
  }
  return { dispositions: v.dispositions, summary: v.summary };
}
const reviewOf = (o: any) => o.dispatch?.route === "blocked" ? o.review_unavailable : o.review;
export const acceptedBlockers = (d: Disposition[]) => d.filter(x => x.decision === "accept" && x.material);
export function verifyArtifacts(saved: any) {
  if (digest(readFileSync(saved.workflow, "utf8")) !== saved.sourceDigest || digest(readFileSync(saved.proposal, "utf8")) !== saved.proposalDigest) throw new Error("Draft artifacts changed after presentation; revise and approve the new draft");
}
export function verifyReviewer(artifacts: string, requested: string) {
  const run = JSON.parse(readFileSync(path.join(artifacts, "run.json"), "utf8"));
  const result = JSON.parse(readFileSync(path.join(artifacts, "result.json"), "utf8"));
  const events = readFileSync(path.join(artifacts, "session.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
  const model = events.filter(e => e.type === "model_change").at(-1);
  const thinking = events.filter(e => e.type === "thinking_level_change").at(-1);
  const actual = `${model?.provider}/${model?.modelId}:${thinking?.thinkingLevel}`;
  if (actual !== requested) throw new Error(`Reviewer assignment mismatch: requested ${requested}, recorded ${actual}; no substitution accepted`);
  if (result.status !== "completed" || !text(result.text)) throw new Error("Reviewer result is not completed");
  return { id: run.id, actual, report: result.text };
}
export function decisionPresentation(input: Input, outputs: any) {
  const saved = outputs.save;
  const full = `Original request: ${input.task}\nExisting authority: ${input.authority}\nHandoff: ${input.handoff}\n\n${readFileSync(saved.proposal, "utf8")}\n\nExact workflow:\n${outputs.draft.source}\n\nReview: ${JSON.stringify(reviewOf(outputs))}\nDisposition: ${JSON.stringify(outputs.disposition)}`;
  const refs = `Proposal: ${saved.proposal} SHA256 ${saved.proposalDigest}\nWorkflow: ${saved.workflow} SHA256 ${saved.sourceDigest}\nApproval binds these exact artifacts and only their displayed scope/next action. Read the files before approving. No draft execution by kickoff. Accepted material blockers/unavailable review prevent approved exits; choose Revise or Stop. Follow-through requires evidence original work is done.`;
  // Channel limits are interface constraints, not limits on work size. Never silently omit scope.
  const body = full.length <= 48_000 ? full : `Full details exceed the decision channel's display capacity. This is an EXCERPT, not the complete proposal: inspect both exact files below and the subject's full original/review/disposition before approval.\n\n${readFileSync(saved.proposal, "utf8").slice(0, 20_000)}\n\nReview/disposition excerpt:\n${JSON.stringify({review: reviewOf(outputs), disposition: outputs.disposition}).slice(0, 12_000)}`;
  const blocks: { kind: "paragraph"; text: string }[] = [{ kind: "paragraph", text: refs }];
  for (let i = 0; i < body.length; i += 12_000) blocks.push({ kind: "paragraph", text: body.slice(i, i + 12_000) });
  return { schema: "pi-workflows.decision-presentation.v1" as const, summary: outputs.draft.summary.slice(0, 1_000), blocks };
}
export function approveOutput(outputs: any, followthrough: boolean) {
  const p = outputs.draft as Proposal;
  if (reviewOf(outputs).status !== "reviewed") throw new Error("Review unavailable; cannot claim approval-ready evidence");
  if (acceptedBlockers(outputs.disposition.dispositions).length) throw new Error("Accepted material blockers require revision before approval");
  if (followthrough && (!p.originalDone || !p.doneEvidence.length)) throw new Error("Natural follow-through requires evidence intended work is done");
  verifyArtifacts(outputs.save);
  return { status: followthrough ? "followthrough" : "approved", proposal: p, artifacts: outputs.save, review: reviewOf(outputs), dispositions: outputs.disposition, approval: outputs.decide, executionStarted: false };
}
const choices = defineHumanChoices({
  revise: choice({ label: "Revise together", input: textInput({ name: "instructions", prompt: "What should change?", minLength: 1 }) }),
  approve: choice({ label: "Approve displayed workflow and execution scope" }),
  stop: choice({ label: "Stop; preserve proposal" }),
  followthrough: choice({ label: "Intended work done: approve displayed natural follow-up" }),
});
const readonly = ["read", "grep", "find", "ls"];
export default defineWorkflow({
  source: import.meta.url,
  name: "handoff-kickoff",
  title: "Handoff → co-designed workflow → human decision",
  input: (raw): Input => {
    const v = raw as Input;
    for (const k of ["task", "handoff", "authority", "planner", "reviewer"] as const) if (!text(v?.[k])) throw new Error(`Kickoff needs ${k}`);
    if (!/^[^/]+\/.+:(off|minimal|low|medium|high|xhigh|max)$/.test(v.reviewer)) throw new Error("Reviewer needs explicit provider/model:thinking");
    return { task: v.task, handoff: v.handoff, authority: v.authority, planner: v.planner, reviewer: v.reviewer };
  },
  startAt: "assess",
  maxSteps: 100, // final graph-cycle safeguard, not a model tool/turn quota
  nodes: {
    assess: agent({
      timeoutMs: null, allowedTools: readonly,
      prompt: ({ input }) => `${policy()}\nAssess actual readiness using the existing handoff; no broad rediscovery. No writing, commands or delegation. Current origin model conducts this read-only assessment; configured planner ${input.planner} is the proposed execution planner, not a claim of a model switch.\nRequest: ${input.task}\nHandoff: ${input.handoff}\nAuthority: ${input.authority}`,
      expectedOutput: "{done:string[],remaining:string[],blockers:string[],unknowns:string[]}",
      validate: (v: any) => {
        for (const k of ["done", "remaining", "blockers", "unknowns"]) if (!Array.isArray(v?.[k]) || !v[k].every(text)) throw new Error(`Need ${k} array`);
        return { done: v.done, remaining: v.remaining, blockers: v.blockers, unknowns: v.unknowns };
      },
    }),
    draft: agent({
      timeoutMs: null, allowedTools: readonly,
      prompt: ({ input, outputs }) => `${policy()}\nDraft or reuse the ACTUAL task-specific executable Pi workflow plus readable proposal. Return source as data, never execute it. Existing context stays in this origin; do not repeat orientation. No helpers/framework unless demonstrated task needs them. Read installed authoring docs/examples as needed. Explicitly show exact models, stage permissions, checks, repair stopping points and authority requested. If original work is done, propose its natural next action, not redundant implementation. Scope beyond existing authority must be clearly requested for human approval.\nInput: ${JSON.stringify(input)}\nAssessment: ${JSON.stringify(outputs.assess)}\nPrevious proposal: ${JSON.stringify(outputs.draft ?? null)}\nHuman revision: ${JSON.stringify(outputs.decide ?? null)}\nPrevious review/disposition: ${JSON.stringify({ review: outputs.review, disposition: outputs.disposition })}`,
      expectedOutput: "{summary,scope,authority,models,checks,stopping,nextAction: string,originalDone:boolean,doneEvidence:string[],source:string} (all named text fields are strings; source is complete workflow source)",
      validate: parseProposal,
    }),
    save: action({
      effect: manualEffect("kickoff.save-proposal"),
      run: ({ outputs, state }) => {
        const p = outputs.draft as Proposal;
        const dir = fileURLToPath(new URL(`../lane/${state.runId}/${randomUUID()}/`, import.meta.url));
        mkdirSync(dir, { recursive: true });
        const proposal = path.join(dir, "proposal.md"), workflow = path.join(dir, "execution.workflow.ts");
        const readable = `# ${p.summary}\n\n## Scope\n${p.scope}\n\n## Authority requested\n${p.authority}\n\n## Models\n${p.models}\n\n## Checks\n${p.checks}\n\n## Stopping conditions\n${p.stopping}\n\n## Next action\n${p.nextAction}\n\n## Intended work already done: ${p.originalDone}\n${p.doneEvidence.join("\n")}\n\nDraft only. No execution has started.\n`;
        writeFileSync(proposal, readable, { flag: "wx" }); writeFileSync(workflow, p.source, { flag: "wx" });
        return { proposal, workflow, sourceDigest: digest(p.source), proposalDigest: digest(readable) };
      },
    }),
    dispatch: agent({
      timeoutMs: null, allowedTools: ["subagent"],
      prompt: ({ input, outputs }) => `Launch exactly one visible Rex subagent with fork:false, model:${JSON.stringify(input.reviewer)}, task containing ALL policy and assignment below. No quota or arbitrary deadline. Rex currently inherits origin thinking and can override a model suffix; recorded actual provider/model/thinking will be checked before accepting review. Mismatch is blocked, never silently accepted.\n${policy()}\nAssignment: read ${outputs.save.proposal} and ${outputs.save.workflow}; judge intended outcome, overhead, permissions, authority and stopping conditions. Request: ${input.task}\nHandoff: ${input.handoff}\nAuthority: ${input.authority}\nNo edits, commands, builds, delegation or workflow controls. Return blockers with id,condition,evidence,consequence,beforeDelivery; separate notes/unknowns. Zero findings is valid. Confirm actual provider/model/thinking.\nIMMEDIATELY submit {id,artifacts,blocked:''} from the launch receipt to COMPLETE DISPATCH in this turn. Do not wait for review or merely end the turn. Launch failure submits {id:'',artifacts:'',blocked:'reason'}. Never duplicate an uncertain launch.`,
      expectedOutput: "{id:string,artifacts:string,blocked:string}",
      validate: (v: any) => {
        if (!v || typeof v.blocked !== "string" || (!text(v.blocked) && (!/^[a-f0-9-]{36}$/.test(v.id) || !path.isAbsolute(v.artifacts)))) throw new Error("Need actual dispatch receipt or launch blocker");
        return { id: v.id, artifacts: v.artifacts, blocked: v.blocked, route: text(v.blocked) ? "blocked" : "waiting" };
      },
    }),
    await_review: checkpoint({
      summary: "Reviewer dispatched; wait for automatic Rex completion, not a model result",
      run: ({ outputs }) => ({ dispatch: outputs.dispatch, instructions: "No polling or duplicate launch. On automatic completion for this exact id, answer this ordinary checkpoint with {id:<same id>}; then collect the actual result. The dispatch agent step is already complete. Cancellation stops continuation; late result may be retained/closed, never restarts a run." }),
    }),
    review: agent({
      timeoutMs: null, allowedTools: ["read", "rex_finish"],
      prompt: ({ input, outputs }) => `Collect only the completed reviewer ${outputs.dispatch.id}. Read ${outputs.dispatch.artifacts}/result.json and session.jsonl, translate actual findings faithfully into the review shape below. No launch or polling. Check actual provider/model/thinking against ${input.reviewer}; if mismatched, return blocked with reason in unknowns. Promptly rex_finish the completed id, never fabricate a clean report.`,
      expectedOutput: "{status:'reviewed'|'blocked',findings:[{id,condition,evidence,consequence,beforeDelivery}],notes:string[],unknowns:string[]}",
      validate: (v: any, { input, outputs }) => {
        if (outputs.await_review?.id !== outputs.dispatch.id) throw new Error("Completion id does not match dispatched reviewer");
        if (v?.status === "reviewed") {
          const actual = verifyReviewer(outputs.dispatch.artifacts, input.reviewer);
          if (actual.id !== outputs.dispatch.id) throw new Error("Reviewer artifact id mismatch");
        }
        if (!["reviewed", "blocked"].includes(v?.status) || !Array.isArray(v.findings) || !Array.isArray(v.notes) || !v.notes.every(text) || !Array.isArray(v.unknowns) || !v.unknowns.every(text)) throw new Error("Invalid review");
        const ids = new Set();
        for (const f of v.findings) { for (const k of ["id", "condition", "evidence", "consequence", "beforeDelivery"]) if (!text(f[k])) throw new Error(`Finding needs ${k}`); if (ids.has(f.id)) throw new Error("Duplicate finding id"); ids.add(f.id); }
        if (v.status === "blocked" && !v.unknowns.length) throw new Error("Unavailable review needs reason in unknowns");
        return v;
      },
    }),
    review_unavailable: compute({ run: ({ outputs }) => ({ status: "blocked", findings: [], notes: [], unknowns: [outputs.dispatch.blocked] }) }),
    disposition: agent({
      timeoutMs: null, allowedTools: readonly,
      prompt: ({ outputs }) => `${policy()}\nDisposition each reviewer claim against intended use. No automatic repair or new review. Accepted material blockers require human revision, not a reviewer veto or silent code changes. Explain evidence and alternatives for joint co-design; user can discuss the displayed proposal before answering and use Revise with exact feedback.\nProposal: ${JSON.stringify(outputs.draft)}\nReview: ${JSON.stringify(reviewOf(outputs))}`,
      expectedOutput: "{dispositions:[{id,decision:'accept'|'reject'|'defer',material:boolean,reason:string}],summary:string}",
      validate: (v, { outputs }) => parseDispositions(v, reviewOf(outputs).findings),
    }),
    decide: humanDecision({
      audience: "operator", choices,
      request: ({ input, outputs }) => ({
        title: "Co-design kickoff: review scope and workflow before execution",
        subject: { original: input, proposal: outputs.draft, artifacts: outputs.save, review: reviewOf(outputs), disposition: outputs.disposition },
        presentation: decisionPresentation(input, outputs),
      }),
    }),
    approved: action({ effect: manualEffect("kickoff.approved-readback"), run: ({ outputs }) => approveOutput(outputs, false) }),
    followthrough: action({ effect: manualEffect("kickoff.followthrough-readback"), run: ({ outputs }) => approveOutput(outputs, true) }),
    stopped: compute({ run: ({ outputs }) => ({ status: "stopped", artifacts: outputs.save, executionStarted: false }) }),
  },
  exits: { approved: { from: "approved" }, followthrough: { from: "followthrough" }, stopped: { from: "stopped" } },
  edges: [
    { from: "assess", to: "draft" }, { from: "draft", to: "save" },
    { from: "save", to: "dispatch" },
    { from: "dispatch", switch: { on: "$.route", cases: { waiting: "await_review", blocked: "review_unavailable" } } },
    { from: "await_review", to: "review" }, { from: "review", to: "disposition" },
    { from: "review_unavailable", to: "disposition" }, { from: "disposition", to: "decide" },
    humanDecisionEdge({ from: "decide", choices, cases: { revise: "draft", approve: "approved", stop: "stopped", followthrough: "followthrough" } }),
  ],
});
