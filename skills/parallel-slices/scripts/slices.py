#!/usr/bin/env python3
"""The one dispatch engine for parallel slices. Do not copy it into a task; give it a tasks file.

  python3 slices.py TASKS.py --model M --effort low --rates 2,10 --expect-out 15000 --baseline 0.17 --dry-run
  python3 slices.py TASKS.py ...same flags... --only id1,id2          # pilot or retry
  python3 slices.py TASKS.py ...same flags...                          # send

TASKS.py holds data only:
  REPOS = {"piw": "/abs/path/to/repo"}
  SYSTEM = "..."                                   # optional
  TASKS = [{"custom_id": "x", "prompt": "...", "output_files": ["piw:src/x.ts"],
            "context_files": ["piw:src/types.ts", "piw:src/server.ts#L120-340"]}]

Context is capped at 32 KB per entry. A larger file must be cut to the lines the slice needs with #Lstart-end.
Sending refuses an estimate above 2x the baseline per slice unless --accept-multiple covers it.
The key is read from the environment variable named by --key-env and never printed.
"""
import argparse, importlib.util, json, os, re, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

CONTEXT_CAP_BYTES = 32 * 1024  # fixed: every cheap run used it; the 2026-11-21 run that dropped it cost 8x per slice
MAX_MULTIPLE = 2.0
TIMEOUT, MAX_RETRIES, RETRY_DELAY = 900, 3, 2.0
DEFAULT_SYSTEM = (
    "You are a principal software engineer. Follow the conventions of the attached repository excerpts. "
    "Return only the files asked for, in the return format given."
)
ENTRY_RE = re.compile(r"^(?P<label>[A-Za-z0-9_-]+):(?P<rel>[^#]+?)(?:#L(?P<a>\d+)-(?P<b>\d+))?$")
FILE_RE = re.compile(
    r"^=== FILE: (?P<path>[^\n]+?) ===[ \t]*\n```[a-zA-Z0-9_-]*[ \t]*\n(?P<body>[\s\S]*?)\n```[ \t]*(?=\n+=== FILE: |\s*\Z)",
    re.M,
)


def fail(msg: str):
    sys.exit(f"slices: {msg}")


def load_tasks(path: Path):
    spec = importlib.util.spec_from_file_location("slice_tasks", path)
    if spec is None or spec.loader is None:
        fail(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    repos = {k: Path(v).resolve() for k, v in getattr(mod, "REPOS", {}).items()}
    tasks = getattr(mod, "TASKS", None)
    if not repos or not tasks:
        fail(f"{path} must define REPOS and TASKS")
    return repos, tasks, getattr(mod, "SYSTEM", DEFAULT_SYSTEM)


def locate(repos, entry: str):
    m = ENTRY_RE.match(entry)
    if not m or m["label"] not in repos:
        fail(f"bad entry {entry!r}: expected <repo label>:<path>[#Lstart-end] with a label from REPOS")
    repo = repos[m["label"]]
    path = (repo / m["rel"]).resolve()
    if not path.is_relative_to(repo):
        fail(f"{entry} is outside its repository")
    lines = (int(m["a"]), int(m["b"])) if m["a"] else None
    return repo, m["rel"], path, lines


def context_block(repos, cid: str, entry: str) -> str:
    repo, rel, path, lines = locate(repos, entry)
    if not path.is_file():
        fail(f"{cid}: context file not found: {path}")
    text = path.read_text(encoding="utf-8", errors="replace")
    label = f"`{rel}` (repository {repo.name}, complete file)"
    if lines:
        a, b = lines
        all_lines = text.split("\n")
        if not 1 <= a <= b <= len(all_lines):
            fail(f"{cid}: {entry} is outside the file's {len(all_lines)} lines")
        text = "\n".join(all_lines[a - 1 : b])
        label = f"`{rel}` lines {a}-{b} of {len(all_lines)} (repository {repo.name})"
    size = len(text.encode("utf-8"))
    if size > CONTEXT_CAP_BYTES:
        fail(
            f"{cid}: {entry} is {size:,} bytes, over the {CONTEXT_CAP_BYTES:,}-byte context cap. "
            "Attach only the lines the slice needs with #Lstart-end."
        )
    return f"### {label}\n````\n{text}\n````"


def build_prompt(repos, task) -> str:
    blocks = [context_block(repos, task["custom_id"], e) for e in task.get("context_files", [])]
    return (
        f"=== REPOSITORY CONTEXT ({len(blocks)} excerpts) ===\n\n"
        + "\n\n".join(blocks)
        + "\n\n=== TASK SPECIFICATION ===\n\n"
        + task["prompt"].strip()
        + "\n"
    )


def estimate(prompt_chars: int, args) -> float:
    return prompt_chars / 4 * args.rates[0] / 1e6 + args.expect_out * args.rates[1] / 1e6


def post(args, key: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    last = "no attempt made"
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(
            args.endpoint,
            data=body,
            method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                data = json.loads(res.read().decode("utf-8"))
            if "error" not in data:
                return data
            last = str(data["error"].get("message", data["error"]))[:300]
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"
            if e.code in (400, 401, 402, 403, 404):
                break
        except Exception as e:  # timeouts and resets; a timed-out request may still be billed
            last = f"{type(e).__name__}: {e}"
        time.sleep(RETRY_DELAY * (attempt + 1))
    raise RuntimeError(last)


def split_files(content: str):
    content = re.sub(r"^<think>[\s\S]*?</think>\s*", "", (content or "").replace("\r\n", "\n"))
    return {m["path"].strip().strip("`"): m["body"] for m in FILE_RE.finditer(content)}


def run_task(args, key, repos, system, task, out: Path):
    start = time.time()
    cid = task["custom_id"]
    payload = {
        "model": args.model,
        "temperature": 0.0,
        "max_tokens": args.max_tokens,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": build_prompt(repos, task)}],
    }
    if args.effort != "none":
        payload["reasoning"] = {"effort": args.effort}
    try:
        res = post(args, key, payload)
        choice = (res.get("choices") or [{}])[0]
        raw = (choice.get("message") or {}).get("content") or ""
        ret = out / "_returns" / f"{cid}.md"
        ret.parent.mkdir(parents=True, exist_ok=True)
        ret.write_text(raw, encoding="utf-8")
        usage = res.get("usage") or {}
        finish = str(choice.get("finish_reason") or choice.get("native_finish_reason") or "")
        record = {"usage": usage, "model": res.get("model"), "effort": args.effort, "seconds": round(time.time() - start, 1), "finish": finish}
        (out / "_returns" / f"{cid}.usage.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        result = {"task": task, "seconds": time.time() - start, "usage": usage}
        if finish.lower() in ("length", "max_tokens"):
            return {**result, "ok": False, "error": f"cut off at max_tokens={args.max_tokens}; partial text in {ret}"}
        if not raw.strip():
            return {**result, "ok": False, "error": "empty return"}
        files = split_files(raw)
        wanted = {}
        for e in task["output_files"]:
            repo, rel, _, _ = locate(repos, e)
            wanted[rel] = repo.name
        for rel, repo_name in wanted.items():
            if rel in files:
                target = out / repo_name / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(files[rel] + "\n", encoding="utf-8")
        missing = [f for f in wanted if f not in files]
        if missing:
            return {**result, "ok": False, "error": f"missing files {missing}; raw return in {ret}"}
        return {**result, "ok": True, "lines": {f: files[f].count("\n") + 1 for f in wanted}}
    except Exception as e:
        return {"task": task, "ok": False, "error": str(e), "seconds": time.time() - start, "usage": {}}


def usage_line(u: dict) -> str:
    reasoning = (u.get("completion_tokens_details") or {}).get("reasoning_tokens")
    cost = u.get("cost")
    return (
        f"in {u.get('prompt_tokens')}, out {u.get('completion_tokens')}, reasoning {reasoning}"
        + (f", ${cost:.2f}" if isinstance(cost, (int, float)) else "")
    )


def rates(text: str):
    try:
        a, b = (float(x) for x in text.split(","))
        return a, b
    except ValueError:
        raise argparse.ArgumentTypeError("expected IN,OUT dollars per million tokens, for example 2,10")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tasks", type=Path, help="tasks file defining REPOS and TASKS")
    ap.add_argument("--model", required=True, help="exact provider model id")
    ap.add_argument("--effort", required=True, choices=["none", "low", "medium", "high"], help="reasoning.effort; none sends no reasoning field")
    ap.add_argument("--rates", required=True, type=rates, help="IN,OUT dollars per million tokens, from the provider's current price list")
    ap.add_argument("--expect-out", required=True, type=int, help="expected tokens out per slice, file plus thinking, from the run ledger")
    ap.add_argument("--baseline", required=True, type=float, help="baseline dollars per slice from the run ledger")
    ap.add_argument("--accept-multiple", type=float, default=MAX_MULTIPLE, help="the user's approved multiple of the baseline")
    ap.add_argument("--max-tokens", type=int, default=64000)
    ap.add_argument("--endpoint", default="https://openrouter.ai/api/v1/chat/completions")
    ap.add_argument("--key-env", default="OPENROUTER_API_KEY")
    ap.add_argument("--output", type=Path, help="default: <tasks file stem>_out beside the tasks file")
    ap.add_argument("--only", help="comma-separated slice ids")
    ap.add_argument("--dry-run", action="store_true", help="write prompts, print sizes and the cost comparison, send nothing")
    args = ap.parse_args(argv)

    repos, all_tasks, system = load_tasks(args.tasks.resolve())
    out = (args.output or args.tasks.resolve().with_name(args.tasks.stem + "_out")).resolve()
    ids = args.only.split(",") if args.only else None
    tasks = [t for t in all_tasks if ids is None or t["custom_id"] in ids]
    if not tasks:
        fail(f"--only matched nothing; ids: {', '.join(t['custom_id'] for t in all_tasks)}")

    prompts = {t["custom_id"]: build_prompt(repos, t) for t in tasks}  # fails on a missing or over-cap context entry
    print(f"model {args.model} at {args.endpoint}, effort {args.effort}, max_tokens {args.max_tokens}")
    worst = 0.0
    for t in tasks:
        cid, prompt = t["custom_id"], prompts[t["custom_id"]]
        cost = estimate(len(prompt), args)
        worst = max(worst, cost / args.baseline)
        print(f"  {cid}: ~{len(prompt) // 4:,} tokens in, est ${cost:.2f} ({cost / args.baseline:.1f}x baseline), returns {', '.join(t['output_files'])}")
    total = sum(estimate(len(p), args) for p in prompts.values())
    print(f"batch: {len(tasks)} slice(s), est ${total:.2f}; baseline ${args.baseline * len(tasks):.2f}; worst slice {worst:.1f}x")

    if args.dry_run:
        for cid, prompt in prompts.items():
            p = out / "_prompts" / f"{cid}.md"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(prompt, encoding="utf-8")
        print(f"[dry run] prompts written to {out / '_prompts'}. Nothing was sent.")
        return 0
    if worst > args.accept_multiple:
        fail(f"worst slice is {worst:.1f}x the baseline; the user must approve that multiple (--accept-multiple {worst:.1f}) before sending")
    key = os.environ.get(args.key_env)
    if not key:
        fail(f"{args.key_env} is not set")

    pending = set(prompts)
    started = time.time()
    done = threading.Event()

    def ticker():
        while not done.wait(20):
            print(f"  ... {time.time() - started:4.0f}s  waiting on: {', '.join(sorted(pending))}", flush=True)

    threading.Thread(target=ticker, daemon=True).start()
    failed = []
    with ThreadPoolExecutor(max_workers=min(len(tasks), 16)) as pool:
        futures = []
        for t in tasks:
            print(f"  sent {t['custom_id']}", flush=True)
            futures.append(pool.submit(run_task, args, key, repos, system, t, out))
        for fut in as_completed(futures):
            r = fut.result()
            cid = r["task"]["custom_id"]
            pending.discard(cid)
            if r["ok"]:
                print(f"  ok   {cid}: {r['seconds']:.0f}s, {usage_line(r['usage'])}, lines {r['lines']}", flush=True)
            else:
                print(f"  FAIL {cid}: {r['error']} ({usage_line(r['usage'])})", flush=True)
                failed.append(cid)
    done.set()
    print(f"done in {time.time() - started:.0f}s; usage per slice in {out / '_returns'}")
    if failed:
        print(f"failed: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
