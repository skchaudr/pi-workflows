import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const engine = path.resolve(import.meta.dirname, "../skills/parallel-slices/scripts/slices.py");
const flags = [
  "--model",
  "test/model",
  "--effort",
  "low",
  "--expect-out",
  "15000",
  "--baseline",
  "0.17",
  "--rates",
  "2,10",
];

let dir = "";
let stateDir = "";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "slices-engine-"));
  stateDir = path.join(dir, "state");
  await fs.writeFile(path.join(dir, "big.ts"), `${"// filler line\n".repeat(4000)}`);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function tasksFile(context: string): Promise<string> {
  const file = path.join(dir, "tasks.py");
  await fs.writeFile(
    file,
    [
      `REPOS = {"r": ${JSON.stringify(dir)}}`,
      `TASKS = [{"custom_id": "a", "prompt": "Write x.", "output_files": ["r:x.ts"], "context_files": [${JSON.stringify(context)}]}]`,
    ].join("\n"),
  );
  return file;
}

function run(args: string[]) {
  return spawnSync("python3", [engine, ...args], {
    encoding: "utf8",
    env: { ...process.env, OPENROUTER_API_KEY: "", SLICES_STATE_DIR: stateDir },
  });
}

describe("parallel-slices engine", () => {
  it("refuses a context entry over the 32 KB cap", async () => {
    const result = run(["send", await tasksFile("r:big.ts"), ...flags, "--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("over the 32,768-byte context cap");
  });

  it("accepts a line excerpt of the same file and writes the prompt", async () => {
    const result = run(["send", await tasksFile("r:big.ts#L1-100"), ...flags, "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing sent");
    const prompt = await fs.readFile(path.join(dir, "tasks_out", "_prompts", "a.md"), "utf8");
    expect(prompt).toContain("`big.ts` lines 1-100 of 4001");
  });

  it("refuses to send above twice the baseline without an approved multiple", async () => {
    const pricey = [
      ...flags.slice(0, 4),
      "--expect-out",
      "56000",
      "--baseline",
      "0.17",
      "--rates",
      "3,15",
    ];
    const result = run(["send", await tasksFile("r:big.ts#L1-100"), ...pricey]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the user must approve that multiple");
  });

  it("requires the thinking level, expected output and baseline", async () => {
    const result = run([
      "send",
      await tasksFile("r:big.ts#L1-100"),
      "--model",
      "test/model",
      "--dry-run",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--effort, --expect-out, --baseline");
  });

  it("prints each context entry with its bytes and the batch line", async () => {
    const result = run(["send", await tasksFile("r:big.ts#L1-100"), ...flags, "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "test/model\neffort low · max out 64,000 · $2 in / $10 out per M · --rates",
    );
    expect(result.stdout).toMatch(/slice\s+context\s+in\s+out\s+est\s+× base/);
    expect(result.stdout).toMatch(/\n {2}a\s+1 file {2}1 KB\s+414\s+15\.0k\s+\$0\.15\s+0\.9×/);
    expect(result.stdout).toMatch(/\n {4}big\.ts#L1-100 {3}1\.5 KB/);
    expect(result.stdout).toMatch(/1 slice\s+1 file {2}1 KB .*baseline \$0\.17/);
    expect(result.stdout).toContain("Dry run · prompts in ");
  });

  it("lists context files on a send only with --files", async () => {
    const file = await tasksFile("r:big.ts#L1-100");
    const quiet = run([
      "send",
      file,
      ...flags,
      "--accept-multiple",
      "10",
      "--output",
      dir,
      "--dry-run",
    ]);
    expect(quiet.stdout).toContain("big.ts#L1-100");
    const send = run(["send", file, ...flags]);
    expect(send.stdout).not.toContain("big.ts#L1-100");
    expect(send.stderr).toContain("OPENROUTER_API_KEY is not set");
  });

  it("refuses a non-openrouter endpoint without rates", async () => {
    const noRates = flags.slice(0, -2);
    const result = run([
      "send",
      await tasksFile("r:big.ts#L1-100"),
      ...noRates,
      "--endpoint",
      "http://localhost:1/v1",
      "--dry-run",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pass --rates IN,OUT");
  });

  it("cancels in the countdown on Ctrl-C with exit 130 and nothing sent", async () => {
    const file = await tasksFile("r:big.ts#L1-100");
    const child = spawn("python3", [engine, "send", file, ...flags, "--accept-multiple", "10"], {
      env: { ...process.env, OPENROUTER_API_KEY: "dummy", SLICES_STATE_DIR: stateDir },
    });
    let stdout = "";
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("Sending in")) resolve();
      });
    });
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(stdout).toContain("Cancelled · nothing sent");
    await expect(fs.stat(path.join(dir, "tasks_out", "_returns"))).rejects.toThrow();
  });

  it("prints the ledger table aligned", () => {
    const result = run(["ledger"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Date \(PST\)\s+Repo · runner\s+Model\s+Requests/);
    expect(result.stdout).toMatch(
      /2026-11-21\s+grok-build-acpx · task-scripts\/piw-in-grok\.py\s+google\/gemini-4-neon/,
    );
    expect(result.stdout).not.toContain("`");
  });

  it("exits 2 with usage when there is no subcommand or an unknown one", () => {
    for (const args of [[], ["bogus"]]) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: slices <command>");
    }
  });

  describe("recorded runs", () => {
    const slice = (id: string, ok: boolean, cost: number) => ({
      id,
      ok,
      ...(ok ? {} : { error: "cut off at 4,000 out" }),
      seconds: 3.2,
      promptTokens: 1200,
      completionTokens: 900,
      reasoningTokens: 100,
      cost,
      est: 0.02,
    });
    const record = (name: string, startedAt: string, slices: ReturnType<typeof slice>[]) => ({
      schema: "slices.run.v1",
      startedAt,
      finishedAt: startedAt,
      tasksPath: path.join(dir, name),
      outDir: path.join(dir, `${name.replace(".py", "")}_out`),
      model: "test/model",
      effort: "low",
      maxTokens: 4000,
      rates: { in: 2, out: 10, think: null, source: "--rates" },
      baselinePerSlice: 0.1,
      slices,
      totals: { actual: slices.reduce((n, s) => n + s.cost, 0), est: 0.04, baseline: 0.06 },
    });

    beforeEach(async () => {
      await fs.mkdir(stateDir, { recursive: true });
      const lines = [
        record("old.py", "2026-11-20T18:00:00Z", [slice("one", true, 0.1)]),
        record("new.py", "2026-11-21T18:00:00Z", [
          slice("gate", true, 0.01),
          slice("tab", false, 0.02),
        ]),
      ];
      await fs.writeFile(
        path.join(stateDir, "runs.jsonl"),
        `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      );
    });

    it("lists runs newest first with whole count, cost and multiple", () => {
      const result = run(["runs"]);
      expect(result.status).toBe(0);
      const rows = result.stdout.split("\n");
      expect(
        rows.some((r) =>
          /^ {2}1 {3}2026-11-21 10:00 {3}new\.py\s+test\/model\s+2\s+1\/2\s+\$0\.03/.test(r),
        ),
      ).toBe(true);
      expect(
        rows.some((r) =>
          /^ {2}2 {3}2026-11-20 10:00 {3}old\.py\s+test\/model\s+1\s+1\/1\s+\$0\.10/.test(r),
        ),
      ).toBe(true);
      expect(result.stdout).toMatch(/new\.py.*\$0\.06\s+0\.5×/);
    });

    it("shows each slice of the newest run by index and by tasks file", async () => {
      await fs.writeFile(path.join(dir, "new.py"), "");
      for (const ref of ["1", path.join(dir, "new.py")]) {
        const result = run(["status", ref]);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(
          /✓ gate\s+3s\s+1\.2k in\s+900 out\s+100 think\s+\$0\.01 {2}\(est \$0\.02\)/,
        );
        expect(result.stdout).toMatch(/✗ tab\s+3s\s+cut off at 4,000 out/);
        expect(result.stdout).toContain(path.join(dir, "new_out", "_returns", "gate.md"));
        expect(result.stdout).toContain(
          "1 of 2 whole · actual $0.03 · est $0.04 · baseline $0.06 · 0.5×",
        );
      }
    });

    it("falls back to usage files when no record exists", async () => {
      const returns = path.join(dir, "bare_out", "_returns");
      await fs.mkdir(returns, { recursive: true });
      await fs.writeFile(path.join(returns, "x.md"), "text");
      await fs.writeFile(
        path.join(returns, "x.usage.json"),
        JSON.stringify({
          usage: { prompt_tokens: 500, completion_tokens: 80, cost: 0.002 },
          model: "test/model",
          effort: "low",
          seconds: 2,
          finish: "stop",
        }),
      );
      const result = run(["status", path.join(dir, "bare_out")]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /✓ x\s+2s\s+500 in\s+80 out\s+– think\s+\$0\.0020 {2}\(est –\)/,
      );
      expect(result.stdout).toContain("no run record");
    });

    it("show writes nothing and sends nothing", async () => {
      const result = run(["show", await tasksFile("r:big.ts#L1-100"), ...flags]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\n {4}big\.ts#L1-100 {3}1\.5 KB/);
      expect(result.stdout).not.toContain("Dry run");
      await expect(fs.stat(path.join(dir, "tasks_out"))).rejects.toThrow();
    });
  });

  describe("agy quota", () => {
    // The panel as agy draws it: the bar and the figure share a line.
    const panel = (weekly: string, fiveHour: string) =>
      [
        "└ Models & Quota",
        "  Account: someone@example.com",
        "GEMINI MODELS",
        "  Models within this group: Gemini 4 Neon, Gemini 4 Carbon",
        "  Weekly Limit Remaining",
        `    [████████████████░░] ${weekly}%`,
        "    Refreshes in 6d 19h 0m",
        "  Five Hour Limit Remaining",
        `    [██████████████░░░░] ${fiveHour}%`,
        "    Refreshes in 2h 4m",
        "CLAUDE AND GPT MODELS",
        "  Weekly Limit Remaining",
        "    [██████████████████] 100.00%",
        "    Quota available",
        "  Five Hour Limit Remaining",
        "    [██████████████████] 100.00%",
        "    Quota available",
      ].join("\n");

    async function reading(name: string, weekly: string, fiveHour: string) {
      const file = path.join(dir, `${name}.txt`);
      await fs.writeFile(file, panel(weekly, fiveHour));
      return file;
    }

    it("reads both limits of every model group from the panel", async () => {
      const result = run(["quota", "--from", await reading("now", "96.58", "86.32"), "--json"]);
      expect(result.status).toBe(0);
      const { groups } = JSON.parse(result.stdout);
      expect(groups["GEMINI MODELS"]).toEqual({
        weekly: 96.58,
        weeklyNote: "Refreshes in 6d 19h 0m",
        fiveHour: 86.32,
        fiveHourNote: "Refreshes in 2h 4m",
      });
      expect(groups["CLAUDE AND GPT MODELS"].fiveHour).toBe(100);
    });

    it("fails when the text holds no panel", async () => {
      const file = path.join(dir, "empty.txt");
      await fs.writeFile(file, "Welcome\n> \n");
      const result = run(["quota", "--from", file]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("could not read agy's usage panel");
    });

    it("shows what was used since a saved reading, and says when a limit refreshed", async () => {
      const before = path.join(dir, "before.json");
      await fs.writeFile(
        before,
        run(["quota", "--from", await reading("before", "96.58", "86.32"), "--json"]).stdout,
      );
      const used = run([
        "quota",
        "--from",
        await reading("after", "95.89", "81.10"),
        "--since",
        before,
      ]);
      expect(used.stdout).toContain(
        "GEMINI MODELS: week 96.58→95.89% (used 0.69) · 5h 86.32→81.10% (used 5.22)",
      );
      const refreshed = run([
        "quota",
        "--from",
        await reading("later", "95.89", "100.00"),
        "--since",
        before,
      ]);
      expect(refreshed.stdout).toContain("5h 86.32→100.00% (limit refreshed)");
    });

    it("totals a run from the earliest reading before a slice to the latest one after", async () => {
      const returns = path.join(dir, "run_out", "_returns");
      await fs.mkdir(returns, { recursive: true });
      const slice = (beforeAt: string, afterAt: string, before: number, after: number) => ({
        quota: {
          group: "GEMINI MODELS",
          beforeAt,
          afterAt,
          before: { weekly: before, fiveHour: before },
          after: { weekly: after, fiveHour: after },
        },
      });
      await fs.writeFile(
        path.join(returns, "a.usage.json"),
        JSON.stringify(slice("2026-11-28T03:00:05+00:00", "2026-11-28T03:09:00+00:00", 89, 80)),
      );
      await fs.writeFile(
        path.join(returns, "b.usage.json"),
        JSON.stringify(slice("2026-11-28T03:00:00+00:00", "2026-11-28T03:04:00+00:00", 90, 86)),
      );
      await fs.writeFile(path.join(returns, "c.usage.json"), JSON.stringify({ quota: null }));
      const result = run(["quota", "--run", path.join(dir, "run_out")]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("GEMINI MODELS · 2 slices");
      expect(result.stdout).toContain(
        "week 90.00→80.00% (used 10.00) · 5h 90.00→80.00% (used 10.00)",
      );
    });
  });
});
