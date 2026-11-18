import { compute, defineWorkflow, includeWorkflow } from "@osolmaz/pi-workflows";
import prepare from "./prepare-landing.workflow.ts";
import parallelTasks from "./launch-landing.workflow.ts";
import integrate from "./integrate-landing.workflow.ts";

// One coordinator run. Feature contexts are separate visible Rex Pis.
export default defineWorkflow({
  source: import.meta.url,
  name: "landing",
  title: "Three packets → approval → parallel finish/review → one delivery lane",
  input: (raw) => {
    const v = raw as any;
    if (!v || typeof v.rexSession !== "string" || !v.rexSession.startsWith("session:"))
      throw new Error("Supply the intended rexSession alongside the preparation input");
    return { ...prepare.input!(v), rexSession: v.rexSession };
  },
  startAt: "start",
  maxSteps: 100,
  includes: {
    prepare: includeWorkflow(prepare, { input: ({ input }) => input as any }),
    tasks: includeWorkflow(parallelTasks, {
      input: ({ outputs }) => {
        const p = (outputs.prepare as any).output;
        return { approvedFile: p.file, approvedDigest: p.digest };
      },
    }),
    integrate: includeWorkflow(integrate, {
      input: ({ input, outputs }) => ({
        integrationInput: (outputs.tasks as any).output.integrationInput,
        rexSession: (input as any).rexSession,
      }),
    }),
  },
  nodes: {
    start: compute({ run: () => ({}) }),
    joined: compute({ run: ({ outputs }) => ({ ok: (outputs.tasks as any).output.ok }) }),
    stopped: compute({ run: ({ outputs }) => ({ status: "stopped", proposal: outputs.prepare }) }),
    blocked: compute({ run: ({ outputs }) => ({ status: "needs-scoped-follow-up", evidence: outputs.tasks }) }),
    finish: compute({ run: ({ outputs }) => (outputs.integrate as any).output }),
  },
  edges: [
    { from: "start", to: "prepare" },
    { from: "prepare.approved", to: "tasks" },
    { from: "prepare.stopped", to: "stopped" },
    { from: "tasks.finished", to: "joined" },
    { from: "joined", switch: { on: "$.ok", cases: { true: "integrate", false: "blocked" } } },
    { from: "integrate.finished", to: "finish" },
    { from: "integrate.blocked", to: "finish" },
  ],
});
