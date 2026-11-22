# Run a workflow from Grok Build

This guide starts a pi-workflows run from inside Grok Build, answers its gate there, and inspects
the finished run. Steps can run on Grok, Claude, or Pi in one workflow. Grok Build here means the
fork that ships the `grok-fork` pager and the `grok-acpx-acp` driver.

The commands and keys on this page were run on 2026-11-22 against pi-workflows `2fb32f5` and the
fork at `20aedddf`. The fork is now at `a4650ff1`, which changed wording only.

## Before you start

You need three things on the machine:

- **The fork's binaries.** `scripts/install-fork.sh` in the fork's checkout builds and installs
  `grok-fork` and `grok-acpx-acp` into `~/.grok/bin`.
- **pi-workflows built from this checkout.** Run `npm install` and `npm run build` here. Pi must
  load the package from this checkout: the `packages` list in `settings.json` under `~/.pi/agent`
  holds the checkout's path, not `npm:@osolmaz/pi-workflows`. The published 0.17.7 package does not
  run steps that name an agent.
- **The agents the workflow names.** A step with `agent: "claude"` needs Claude Code signed in. A
  step with `agent: "grok-build"` needs Grok signed in. A step without `agent` runs on Pi.

`/flow` starts the workflow server when none is running, from the package Pi's settings name. Pi
does the same. To check, stop or start it by hand, run these from this checkout:

```bash
node dist/viewer/cli.js server status
```

```bash
node dist/viewer/cli.js server stop
```

```bash
node dist/viewer/cli.js server start
```

Restart it after you pull or rebuild pi-workflows. A running server keeps the code it loaded, so a
server started earlier from the published package keeps running that package until it is stopped.

## Write a workflow

Save this as `mixed.workflow.ts` in any folder. It runs one step on Grok, asks you a question, then
runs one step on Claude and one on Pi.

```ts
import {
  agent,
  choice,
  compute,
  defineHumanChoices,
  defineWorkflow,
  humanDecision,
  humanDecisionEdge,
} from "@osolmaz/pi-workflows";

const step = (who: string) => ({
  prompt: () =>
    `Write three sentences about a harbour town in your reply. Then call the workflow tool to submit exactly {"who": "${who}", "n": 1}. Use no other tool.`,
  expectedOutput: `{"who": "${who}", "n": 1}`,
  validate: (output: unknown) => {
    if ((output as { who?: unknown } | null)?.who !== who) throw new Error(`who must be ${who}`);
    return output;
  },
});

const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});

export default defineWorkflow({
  name: "mixed",
  startAt: "grok",
  nodes: {
    grok: agent({ ...step("grok"), agent: "grok-build" }),
    gate: humanDecision({
      audience: "operator",
      choices,
      request: ({ outputs }) => ({
        title: "Grok answered. Continue to Claude and Pi?",
        subject: { grok: outputs.grok },
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Choose continue to run the Claude and Pi steps, or stop.",
          blocks: [],
        },
      }),
    }),
    claude: agent({ ...step("claude"), agent: "claude" }),
    pi: agent(step("pi")),
    done: compute({
      run: ({ outputs }) => ({ grok: outputs.grok, claude: outputs.claude, pi: outputs.pi }),
    }),
    stopped: compute({ run: () => ({ stopped: true }) }),
  },
  edges: [
    { from: "grok", to: "gate" },
    humanDecisionEdge({ from: "gate", choices, cases: { continue: "claude", stop: "stopped" } }),
    { from: "claude", to: "pi" },
    { from: "pi", to: "done" },
  ],
});
```

[Workflows](WORKFLOWS.md) describes every node type and the `agent` field.

## Start Grok Build and the run

In the folder that holds the workflow file:

```bash
grok acpx
```

`grok` is the shell function from the fork's `scripts/hub/grok-picker.zsh`; the fork's
`scripts/hub/README.md` describes how to install it. `grok grok-pi` starts Pi in the same pager
with the pi-workflows extension loaded, for `/workflow` and `/workflows`.

In Grok Build, start the run:

```
/flow mixed.workflow.ts
```

`/flow` takes a pi-workflows file (`*.workflow.ts`) or an acpx flow file (`*.flow.ts`). Text after
the file name is passed to the run as its task or its JSON input.

## What you see

1. The run's name, its file and run id, and a diagram of the steps.
2. A card for the running step. The agent's text streams into it. When the step ends, the card
   closes to a summary.
3. At the gate, a question with one line per choice. Move with `↑`/`↓` and press `Enter` to answer.
   The run continues in the same turn.
4. The remaining steps, one card each.
5. A last line: `✓ mixed finished in 55s`, `✗ mixed failed: …`, or `✗ mixed cancelled (…)`.

Other things you can do during a run:

- **Leave the gate for later:** press `Shift+x`. The run stays parked at the gate. Answer it later
  with `/answer <label>`, for example `/answer continue`, or from the runs pop-up.
- **Cancel the run:** press `Ctrl+c`, then `Enter` on "Stop running". The run is cancelled on the
  server as well, and the last lines read `✗ mixed cancelled (Workflow run cancelled)` and
  `Turn cancelled.` This also works while the gate question is open.

## Inspect runs

```
/acpx
```

This opens the runs pop-up. Runs that wait for you are listed first, then finished runs.

| Key       | Does                                                        |
| --------- | ----------------------------------------------------------- |
| `j` / `k` | Move in the list                                            |
| `Enter`   | Open the run, then open the selected step                   |
| `1`–`7`   | In a step: switch between Output, Prompt, Response and Meta |
| `[` / `]` | In a step: previous or next step                            |
| `Esc`     | Go back one level, then close                               |
| `?`       | Show all keys                                               |

The run view shows the graph with the path taken, each step with its duration and output, and the
steps that did not run. A step that ran on an agent has a Response tab with the text the agent
wrote.

The driver also answers these commands in the prompt:

| Command            | Does                                              |
| ------------------ | ------------------------------------------------- |
| `/runs`            | List recent acpx flow runs                        |
| `/open <run id>`   | Replay an existing acpx flow run into the session |
| `/answer <choice>` | Answer a waiting gate                             |
| `/acpx-help`       | Show the command list                             |

To watch the same runs from another terminal, use the [`piw` viewer](TUI_VIEWER.md):

```bash
piw
```

## Known problems on 2026-11-22

- After you leave a gate and answer it later with `/answer`, the run continues and completes, but
  the last line shows no name and a wrong duration (`✓ **** finished in 498704h58m`).
- After a cancel, the last diagram and path line still mark the interrupted step as running.
- Answering the gate makes the transcript jump down and back up once.
- In a terminal narrower than about 100 columns the diagram is replaced by its source text.
- `/runs` and `/open` only know acpx flow runs. A pi-workflows run is not listed by `/runs`, and
  `/open` answers `Run … not found` for its id. Use `/acpx` or `piw` for those.

## When the server refuses to start after an update

pi-workflows is in alpha and changes its database layout in place. After such a change the server
stops with this message:

```
Pi Workflows durable state is incompatible. Back up and move state.sqlite with its -wal and -shm files, then start Pi Workflows to create a new state.sqlite database. The incompatible state was not changed.
```

Stop the server, move `state.sqlite`, `state.sqlite-wal` and `state.sqlite-shm` out of the
`workflows` folder under `~/.pi/agent` into a backup folder, and start the server again. Earlier
runs are then gone from the server. The runs pop-up in Grok Build may still list them from its own
copies on disk; they can be read there but no longer answered.
