import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

// One-off establishment task. This is not the reusable kickoff being authored.
export default defineWorkflow({
  name: "establish-kickoff",
  source: import.meta.url,
  title: "Establish kickoff roles and execution boundaries",
  input: (raw) => {
    const v = raw as { task: string; constraints: string; reviewer: string };
    if (!v?.task?.trim() || !v.constraints?.trim() || !v.reviewer?.trim())
      throw new Error("Need task, constraints and exact reviewer model");
    return v;
  },
  startAt: "inspect",
  maxSteps: 4,
  nodes: {
    inspect: agent({
      timeoutMs: null,
      allowedTools: ["read", "grep", "find", "ls"],
      prompt: ({ input }) => [
        "Inspect existing workflow primitives and role/config loading for this agreed task. Reuse conversation evidence; do not repeat broad discovery.",
        input.task, input.constraints,
        "Return the specific files to change and a short implementation sequence. No writes, shells or delegation. Identify real limitations, not speculative prerequisites.",
      ].join("\n"),
      expectedOutput: "{files:string[],sequence:string[],limitations:string[]}",
    }),
    implement: agent({
      timeoutMs: null,
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      prompt: ({ input, outputs }) => [
        "Implement the agreed task, not a general-purpose orchestration framework. Preserve unrelated dirty files. Read relevant installed docs before authoring.",
        input.task, input.constraints,
        `Inspection: ${JSON.stringify(outputs.inspect)}`,
        "Do not modify this running workflow. Do not launch another workflow or any worker. Verify with a few decisive local checks, not a speculative test framework. Return changed paths, actual checks and limitations.",
      ].join("\n"),
      expectedOutput: "{files:string[],checks:string[],limitations:string[]}",
    }),
    review: agent({
      timeoutMs: null,
      allowedTools: ["subagent", "read", "rex_finish"],
      prompt: ({ input, outputs }) => [
        `Launch exactly one visible Rex subagent with fork:false and model:${input.reviewer}. No tool-call quota or arbitrary agent deadline. Return blocked if that model is unavailable; never substitute.`,
        "Its assignment: independently review only the following change against the agreed task. No edits, builds, commands, further delegation or workflow controls. Read relevant files. Zero findings is valid. Each proposed blocker needs concrete evidence, material consequence and why it must prevent intended use now. Separate nonblocking notes and unknowns. Review is evidence, not a veto.",
        input.task, input.constraints,
        `Implementation handoff: ${JSON.stringify(outputs.implement)}`,
        "Finish your turn for automatic delivery; do not poll. After delivery, review the handoff, promptly rex_finish the completed agent, and submit its actual findings without inventing a clean result.",
      ].join("\n"),
      expectedOutput: "{status:'reviewed'|'blocked',blockers:unknown[],notes:string[],evidence:string[]}",
    }),
    disposition: agent({
      timeoutMs: null,
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      prompt: ({ input, outputs }) => [
        "Evaluate reviewer claims against intended outcomes. Accept/reject/defer each with reasons. Only accepted material blockers justify scoped repair. One repair-and-check pass here, no new reviewers or automatic loops. If unresolved, return the exact blocker and preserve work.",
        input.task, input.constraints,
        `Implementation: ${JSON.stringify(outputs.implement)}\nReview: ${JSON.stringify(outputs.review)}`,
        "Report what is genuinely wired versus merely documented, checks actually run, remaining limitations, and the exact user command for the new kickoff. Do not execute it. Write a concise daily-memory note of durable results. Do not modify this running workflow.",
      ].join("\n"),
      expectedOutput: "{status:'established'|'blocked',files:string[],dispositions:string[],checks:string[],limitations:string[],command:string}",
    }),
  },
  edges: [
    { from: "inspect", to: "implement" },
    { from: "implement", to: "review" },
    { from: "review", to: "disposition" },
  ],
});
