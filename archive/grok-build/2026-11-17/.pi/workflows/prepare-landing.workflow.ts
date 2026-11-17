import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  agent,
  action,
  choice,
  compute,
  defineHumanChoices,
  defineWorkflow,
  humanDecision,
  humanDecisionEdge,
  manualEffect,
  textInput,
} from "@osolmaz/pi-workflows";
import { digest, parseModel, parsePackets, parseReviewBound } from "./lib/landing-contracts.mjs";

type Input = {
  cwd: string;
  goal: string;
  context: string[];
  planner: ReturnType<typeof parseModel>;
  builders: Record<string, ReturnType<typeof parseModel>>;
  reviewer: ReturnType<typeof parseModel>;
  evaluator: ReturnType<typeof parseModel>;
  reviewRounds: number;
  delivery: "merge-push-install-mini-air";
};
const choices = defineHumanChoices({
  approve: choice({ label: "Approve packets and execute through merge, push and Mini/Air installation" }),
  revise: choice({
    label: "Revise packets",
    input: textInput({ name: "instructions", prompt: "What should change?", minLength: 1 }),
  }),
  stop: choice({ label: "Stop; preserve packets" }),
});
export default defineWorkflow({
  source: import.meta.url,
  name: "prepare-landing",
  title: "Detail three tasks → human packet review",
  input: (raw): Input => {
    const v = raw as Input;
    if (
      !v ||
      !path.isAbsolute(v.cwd) ||
      !v.goal?.trim() ||
      !Array.isArray(v.context) ||
      !v.context.length ||
      v.delivery !== "merge-push-install-mini-air"
    )
      throw new Error("Need absolute cwd, goal and shared context");
    const builders = Object.fromEntries(
      ["f3", "cass", "claude-settings"].map((id) => [id, parseModel(v.builders?.[id])]),
    );
    return {
      cwd: v.cwd,
      goal: v.goal,
      context: v.context,
      planner: parseModel(v.planner),
      builders,
      reviewer: parseModel(v.reviewer),
      evaluator: parseModel(v.evaluator),
      reviewRounds: parseReviewBound(v.reviewRounds),
      delivery: v.delivery,
    };
  },
  startAt: "detail_packets",
  maxSteps: 30,
  exits: { approved: { from: "approved" }, stopped: { from: "stopped" } },
  nodes: {
    detail_packets: agent({
      timeoutMs: null,
      allowedTools: ["subagent", "read", "rex_finish"],
      prompt: ({ input, outputs }) => {
        const v = input as Input;
        return [
          `Delegate the preparation assignment below to exactly one fresh subagent, fork:false, cwd:${JSON.stringify(v.cwd)}, model:${JSON.stringify(`${v.planner.provider}/${v.planner.model}:${v.planner.thinking}`)}, name:'landing-packets'. This must match this parent's actual model; do not substitute.`,
          "End your turn for automatic delivery. Do not poll. When it returns, close that completed subagent and submit its {base,packets,notes} here. Do not perform the investigation in this coordinating context.",
          "PREPARATION ASSIGNMENT:",
          `You are the detail-preparation parent, not a direction-setting planner. Confirm your actual model is ${v.planner.provider}/${v.planner.model}; block rather than substitute.`,
          `Read-only investigation in ${v.cwd}. No edits, checkout, Cargo, tests, dispatch, install or server changes.`,
          `Our already selected overall goal: ${v.goal}`,
          `Shared evidence: ${JSON.stringify(v.context)}`,
          "Investigate the implementation, branch tips, existing test/review evidence enough to remove rediscovery from each builder. Do not audit unrelated repository work.",
          "Prepare exactly three independent task packets: f3, cass, claude-settings. Specify the laser-focused goal, exact evidence/file references, concrete unfinished behaviour, write boundaries, and a few decisive acceptance outcomes.",
          "Tests/snapshots belong to each feature. Cross-feature overlaps are returned as integration notes, not a reason to serialize all work. Treat each startingRef as a commit to investigate/integrate, not permission to overwrite main.",
          `Fixed approved model assignments for this proposal: ${JSON.stringify(v.builders)}. Reviewer: ${JSON.stringify(v.reviewer)}; maximum review rounds: ${v.reviewRounds}. Do not change them.`,
          "Each packet: {id,goal,context:[evidence and integration notes],files:[repo-relative exact paths or directories],constraints:[...],acceptance:[...],startingRef:'full commit SHA',builder:{provider,model,thinking:'high'}}.",
          "The constraints must say no Cargo, no installs, no push/main merge, no unrelated changes; commit only explicit task paths. Preserve the user goal rather than laundering agent guesses into requirements.",
          outputs.packet_gate
            ? `Human requested revision: ${JSON.stringify(outputs.packet_gate)}`
            : "",
          "Return {base:'full current main SHA',packets:[...],notes:'remaining uncertainties and cross-task overlaps'}. These exact packets will be displayed to the human; do not execute them.",
        ].join("\n");
      },
      expectedOutput: "{base:string,packets:[packet,packet,packet],notes:string}",
      validate: (raw, { input }) => {
        const v = raw as any,
          i = input as Input;
        if (!/^[a-f0-9]{40}$/.test(v?.base) || typeof v.notes !== "string")
          throw new Error("Need pinned main revision and notes");
        const base = execFileSync("git", ["rev-parse", "main"], {
          cwd: i.cwd,
          encoding: "utf8",
        }).trim();
        if (v.base !== base) throw new Error("Main changed during packet preparation");
        const packets = parsePackets(v.packets);
        for (const p of packets) {
          if (!/^[a-f0-9]{40}$/.test(p.startingRef))
            throw new Error("Pin each startingRef to full SHA");
          execFileSync("git", ["cat-file", "-e", `${p.startingRef}^{commit}`], { cwd: i.cwd });
          if (digest(p.builder) !== digest(i.builders[p.id]))
            throw new Error("Packet changed model assignment");
        }
        return { base, packets, notes: v.notes };
      },
    }),
    sanity_check: agent({
      timeoutMs: null,
      allowedTools: ["read", "bash"],
      prompt: ({ outputs }) => [
        "Sanity-check the preparation Pi's three packets against the operator's requested F3, Cass and Claude work. Do not redo its repository investigation or add requirements.",
        JSON.stringify(outputs.detail_packets),
        "Return {note:'concise scope check and any concrete concern for the human gate'}. Do not implement or dispatch anything; the human decides next.",
      ].join("\n"),
      expectedOutput: "{note:string}",
    }),
    packet_gate: humanDecision({
      audience: "operator",
      choices,
      request: ({ input, outputs }) => ({
        title: "Review exactly what the three builders will receive",
        subject: { input, proposal: outputs.detail_packets },
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary:
            "Approval starts three builders and independent check design, then integration, final review, serial release tests, merge/push and one install-fork.sh for Mini and Air. Revise changes the packets; stop ends the run.",
          blocks: [
            { kind: "paragraph", text: (outputs.detail_packets as any).notes },
            { kind: "paragraph", text: (outputs.sanity_check as any).note },
            {
              kind: "preformatted",
              text: JSON.stringify(
                {
                  reviewer: (input as Input).reviewer,
                  evaluator: (input as Input).evaluator,
                  reviewRounds: (input as Input).reviewRounds,
                  delivery: (input as Input).delivery,
                },
                null,
                2,
              ),
            },
            ...(outputs.detail_packets as any).packets.flatMap((p: any) => [
              { kind: "section", title: p.id },
              { kind: "preformatted", text: JSON.stringify(p, null, 2) },
            ]),
          ],
        },
      }),
    }),
    approved: action({
      effect: manualEffect("landing.approved-packets"),
      run: ({ input, outputs, state }) => {
        const v = input as Input;
        const bundle = {
          schema: "grok-landing.approved.v1",
          cwd: v.cwd,
          goal: v.goal,
          ...(outputs.detail_packets as any),
          reviewer: v.reviewer,
          evaluator: v.evaluator,
          reviewRounds: v.reviewRounds,
          delivery: v.delivery,
          approval: outputs.packet_gate,
          runId: state.runId,
        };
        const dir = path.join(v.cwd, ".pi", "lane", state.runId);
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "approved-packets.json");
        writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n", { flag: "wx" });
        return {
          status: "approved",
          file,
          digest: digest(bundle),
          next: "The parent landing workflow now launches the approved work; no second launch approval is required.",
        };
      },
    }),
    stopped: compute({
      run: ({ outputs }) => ({ status: "stopped", proposal: outputs.detail_packets }),
    }),
  },
  edges: [
    { from: "detail_packets", to: "sanity_check" },
    { from: "sanity_check", to: "packet_gate" },
    humanDecisionEdge({
      from: "packet_gate",
      choices,
      cases: { approve: "approved", revise: "detail_packets", stop: "stopped" },
    }),
  ],
});
