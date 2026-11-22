import { spawnSync } from "node:child_process";
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
  "--rates",
  "2,10",
  "--expect-out",
  "15000",
  "--baseline",
  "0.17",
];

let dir = "";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "slices-engine-"));
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
    env: { ...process.env, OPENROUTER_API_KEY: "" },
  });
}

describe("parallel-slices engine", () => {
  it("refuses a context entry over the 32 KB cap", async () => {
    const result = run([await tasksFile("r:big.ts"), ...flags, "--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("over the 32,768-byte context cap");
  });

  it("accepts a line excerpt of the same file and writes the prompt", async () => {
    const result = run([await tasksFile("r:big.ts#L1-100"), ...flags, "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Nothing was sent");
    const prompt = await fs.readFile(path.join(dir, "tasks_out", "_prompts", "a.md"), "utf8");
    expect(prompt).toContain("`big.ts` lines 1-100 of 4001");
  });

  it("refuses to send above twice the baseline without an approved multiple", async () => {
    const pricey = [...flags.slice(0, 5), "3,15", "--expect-out", "56000", "--baseline", "0.17"];
    const result = run([await tasksFile("r:big.ts#L1-100"), ...pricey]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the user must approve that multiple");
  });

  it("requires the thinking level, rates, expected output and baseline", async () => {
    const result = run([await tasksFile("r:big.ts#L1-100"), "--model", "test/model", "--dry-run"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--effort, --rates, --expect-out, --baseline");
  });
});
