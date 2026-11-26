#!/usr/bin/env node
// Serves a workflow's design doc, the `<name>.design.html` beside `<name>.workflow.ts`, and saves
// the comments typed into it: they are written into the doc's notes block, then committed and
// pushed in the workflow's repository.
import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const NOTES_BLOCK = /(<script type="application\/json" id="notes">)[\s\S]*?(<\/script>)/;

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag === -1 ? 7717 : Number(args.splice(portFlag, 2)[1]);
if (args.length !== 1 || !args[0].endsWith(".workflow.ts") || !Number.isInteger(port)) {
  console.error("usage: serve.mjs <path/to/name.workflow.ts> [--port <number>]");
  process.exit(2);
}
const workflowPath = resolve(args[0]);
const dir = dirname(workflowPath);
const name = basename(workflowPath, ".workflow.ts");
const docPath = resolve(dir, `${name}.design.html`);
const origin = `http://127.0.0.1:${port}`;

const readNotes = (html) => {
  const block = NOTES_BLOCK.exec(html);
  if (block === null) throw new Error(`${docPath} has no <script id="notes"> block`);
  return JSON.parse(block[0].slice(block[1].length, -block[2].length));
};

// Empty comments are dropped so a cleared box leaves no key behind.
const clean = (notes) =>
  Object.fromEntries(
    Object.entries(notes)
      .map(([graph, byId]) => [
        graph,
        Object.fromEntries(Object.entries(byId).filter(([, text]) => text.trim() !== "")),
      ])
      .filter(([, byId]) => Object.keys(byId).length > 0),
  );

const changedIds = (before, after) => {
  const ids = [];
  for (const graph of new Set([...Object.keys(before), ...Object.keys(after)]))
    for (const id of new Set([
      ...Object.keys(before[graph] ?? {}),
      ...Object.keys(after[graph] ?? {}),
    ]))
      if (before[graph]?.[id] !== after[graph]?.[id]) ids.push(id);
  return ids;
};

const git = (...gitArgs) => run("git", ["-C", dir, ...gitArgs]);

async function committedNotes() {
  try {
    const prefix = (await git("rev-parse", "--show-prefix")).stdout.trim();
    return readNotes((await git("show", `HEAD:${prefix}${basename(docPath)}`)).stdout);
  } catch {
    return {}; // the doc is not committed yet
  }
}

async function save(notes, commit) {
  const html = await readFile(docPath, "utf8");
  readNotes(html); // refuse to write into a doc without the block
  const json = JSON.stringify(clean(notes), null, 2).replaceAll("<", "\\u003c");
  const next = html.replace(NOTES_BLOCK, (_, open, close) => `${open}\n${json}\n${close}`);
  if (next !== html) {
    await writeFile(`${docPath}.tmp`, next);
    await rename(`${docPath}.tmp`, docPath);
  }
  if (!commit) return { saved: true };

  const ids = changedIds(await committedNotes(), clean(notes));
  await git("add", "--", docPath);
  const staged = await git("diff", "--cached", "--quiet", "--", docPath).then(
    () => false,
    () => true,
  );
  if (staged) {
    const what = ids.length > 0 ? ` (${ids.join(", ")})` : "";
    await git("commit", "-q", "-m", `docs(workflows): comments on ${name}${what}`, "--", docPath);
  }
  const sha = (await git("rev-parse", "--short", "HEAD")).stdout.trim();
  try {
    await git("push", "-q");
    return { saved: true, sha, pushed: true };
  } catch (error) {
    return { saved: true, sha, pushed: false, error: String(error.stderr || error.message).trim() };
  }
}

// One save at a time, so two saves never run git together.
let queue = Promise.resolve();
const inOrder = (work) => {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
};

const body = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const server = createServer(async (req, res) => {
  const send = (status, type, text) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(text);
  };
  try {
    // Only this page may talk to the server: it writes a file and runs git.
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      return send(403, "text/plain", "wrong host");
    if (req.method === "GET" && req.url === "/")
      return send(200, "text/html; charset=utf-8", await readFile(docPath, "utf8"));
    if (req.method === "GET" && req.url === "/source")
      return send(200, "text/plain; charset=utf-8", await readFile(workflowPath, "utf8"));
    if (req.method === "PUT" && req.url === "/notes") {
      const from = req.headers.origin;
      if (from !== origin && from !== `http://localhost:${port}`)
        return send(403, "text/plain", "wrong origin");
      const { notes, commit } = JSON.parse(await body(req));
      const result = await inOrder(() => save(notes, commit === true));
      return send(200, "application/json", JSON.stringify(result));
    }
    return send(404, "text/plain", "not found");
  } catch (error) {
    return send(500, "application/json", JSON.stringify({ saved: false, error: error.message }));
  }
});

await readFile(docPath, "utf8").then(readNotes);
server.listen(port, "127.0.0.1", () => console.log(`${name} design doc: ${origin}/`));
