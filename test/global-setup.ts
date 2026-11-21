import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopTempWorkflowServers } from "./temp-workflow-servers.js";

export const TEST_TEMP_ROOT_ENV = "PI_WORKFLOWS_TEST_TEMP_ROOT";

let ownedRoot: string | undefined;
let previousRoot: string | undefined;
let previousConfigDir: string | undefined;

/**
 * Test workflow servers bind a local socket inside their temporary state
 * directory, and macOS allows 103 bytes for that path (`maxSocketPathBytes`).
 * The macOS per-user temporary directory under `/var/folders` already uses
 * about 48 of them, so the root goes under `/tmp` there. The base is resolved
 * because `/tmp` and `/var` are symbolic links on macOS, and Git and the
 * project store report resolved paths that tests compare with their own.
 */
function testTempBase(): string {
  return fs.realpathSync(process.platform === "darwin" ? "/tmp" : os.tmpdir());
}

export function setup(): void {
  previousRoot = process.env[TEST_TEMP_ROOT_ENV];
  if (previousRoot !== undefined) return;

  ownedRoot = fs.mkdtempSync(path.join(testTempBase(), "pw-"));
  process.env[TEST_TEMP_ROOT_ENV] = ownedRoot;
  previousConfigDir = process.env.PI_WORKFLOWS_CONFIG_DIR;
  process.env.PI_WORKFLOWS_CONFIG_DIR = path.join(ownedRoot, "config");
}

export async function teardown(): Promise<void> {
  if (ownedRoot !== undefined) {
    const stopped = await stopTempWorkflowServers(ownedRoot);
    if (stopped > 0) {
      process.stderr.write(
        `test harness stopped ${stopped} workflow server(s) left behind by this run\n`,
      );
    }
    fs.rmSync(ownedRoot, { force: true, recursive: true });
    ownedRoot = undefined;
  }
  if (previousRoot === undefined) delete process.env[TEST_TEMP_ROOT_ENV];
  else process.env[TEST_TEMP_ROOT_ENV] = previousRoot;
  if (previousConfigDir === undefined) delete process.env.PI_WORKFLOWS_CONFIG_DIR;
  else process.env.PI_WORKFLOWS_CONFIG_DIR = previousConfigDir;
  previousRoot = undefined;
  previousConfigDir = undefined;
}
