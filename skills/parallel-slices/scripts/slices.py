#!/usr/bin/env python3
"""The one dispatch engine for parallel slices. Do not copy it into a task; give it a tasks file.

  python3 slices.py TASKS.py --model M --effort low --expect-out 15000 --baseline 0.17 --dry-run
  python3 slices.py TASKS.py ...same flags... --only id1,id2          # pilot or retry
  python3 slices.py TASKS.py ...same flags...                          # send

TASKS.py holds data only:
  REPOS = {"piw": "/abs/path/to/repo"}
  SYSTEM = "..."                                   # optional
  TASKS = [{"custom_id": "x", "prompt": "...", "output_files": ["piw:src/x.ts"],
            "context_files": ["piw:src/types.ts", "piw:src/server.ts#L120-340"]}]

Context is capped at 32 KB per entry. A larger file must be cut to the lines the slice needs with #Lstart-end.
Rates come live from openrouter.ai/api/v1/models; --rates IN,OUT overrides them and is required for any other endpoint.
Dry run and send print the same cost screen. Sending refuses an estimate above 2x the baseline per slice unless
--accept-multiple covers it, then counts down 30 seconds (Ctrl-C cancels, exit 130) before the first request.
The key is read from the environment variable named by --key-env and never printed.
"""
import argparse, importlib.util, json, os, re, signal, sys, threading, time, urllib.error, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

CONTEXT_CAP_BYTES = 32 * 1024  # fixed: every cheap run used it; the 2026-11-21 run that dropped it cost 8x per slice
MAX_MULTIPLE = 2.0
COUNTDOWN_SECONDS = 30  # fixed on purpose: no flag skips or shortens it
OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"
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


def context_part(repos, cid: str, entry: str):
    """Return (label, block, bytes) for one context entry."""
    repo, rel, path, lines = locate(repos, entry)
    if not path.is_file():
        fail(f"{cid}: context file not found: {path}")
    text = path.read_text(encoding="utf-8", errors="replace")
    label = f"`{rel}` (repository {repo.name}, complete file)"
    short = rel
    if lines:
        a, b = lines
        all_lines = text.split("\n")
        if not 1 <= a <= b <= len(all_lines):
            fail(f"{cid}: {entry} is outside the file's {len(all_lines)} lines")
        text = "\n".join(all_lines[a - 1 : b])
        label = f"`{rel}` lines {a}-{b} of {len(all_lines)} (repository {repo.name})"
        short = f"{rel} lines {a}-{b}"
    size = len(text.encode("utf-8"))
    if size > CONTEXT_CAP_BYTES:
        fail(
            f"{cid}: {entry} is {size:,} bytes, over the {CONTEXT_CAP_BYTES:,}-byte context cap. "
            "Attach only the lines the slice needs with #Lstart-end."
        )
    return short, f"### {label}\n````\n{text}\n````", size


def context_parts(repos, task):
    return [context_part(repos, task["custom_id"], e) for e in task.get("context_files", [])]


def build_prompt(parts, task) -> str:
    blocks = [block for _, block, _ in parts]
    return (
        f"=== REPOSITORY CONTEXT ({len(blocks)} excerpts) ===\n\n"
        + "\n\n".join(blocks)
        + "\n\n=== TASK SPECIFICATION ===\n\n"
        + task["prompt"].strip()
        + "\n"
    )


def tokens_of(text: str) -> int:
    return len(text.encode("utf-8")) // 4


def estimate(prompt: str, args) -> float:
    return tokens_of(prompt) * args.rate_in / 1e6 + args.expect_out * args.rate_out / 1e6


def fetch_rates(model: str):
    """Live per-million rates (in, out, reasoning) for a model from OpenRouter, or exit with the reason."""
    try:
        req = urllib.request.Request(OPENROUTER_MODELS, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as res:
            listing = json.loads(res.read().decode("utf-8"))["data"]
    except Exception as e:
        fail(f"cannot read live prices from {OPENROUTER_MODELS} ({type(e).__name__}: {e}); pass --rates IN,OUT to price the run by hand")
    match = next((m for m in listing if m.get("id") == model), None)
    if match is None:
        fail(f"{model} is not listed at {OPENROUTER_MODELS}; check the model id or pass --rates IN,OUT")
    try:
        pricing = match["pricing"]
        rate_in, rate_out = float(pricing["prompt"]) * 1e6, float(pricing["completion"]) * 1e6
        reasoning = float(pricing["internal_reasoning"]) * 1e6 if pricing.get("internal_reasoning") not in (None, "") else None
    except (KeyError, TypeError, ValueError):
        fail(f"{model} has no usable pricing at {OPENROUTER_MODELS}; pass --rates IN,OUT")
    return rate_in, rate_out, reasoning


def money(x: float) -> str:
    return f"${x:.2f}" if x >= 0.01 else f"${x:.4f}"


def ktok(n) -> str:
    if not isinstance(n, (int, float)):
        return "n/a"
    return str(int(n)) if n < 1000 else (f"{n / 1000:.1f}k" if n < 10000 else f"{n / 1000:.0f}k")


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


def run_task(args, key, system, prompt, task, out: Path, repos):
    start = time.time()
    cid = task["custom_id"]
    payload = {
        "model": args.model,
        "temperature": 0.0,
        "max_tokens": args.max_tokens,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
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
        result = {"task": task, "seconds": time.time() - start, "usage": usage, "returned_tokens": tokens_of(raw)}
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
        return {"task": task, "ok": False, "error": str(e), "seconds": time.time() - start, "usage": {}, "returned_tokens": 0}


def actual_cost(u: dict, args) -> float:
    cost = u.get("cost")
    if isinstance(cost, (int, float)):
        return float(cost)
    return (u.get("prompt_tokens") or 0) * args.rate_in / 1e6 + (u.get("completion_tokens") or 0) * args.rate_out / 1e6


def usage_line(u: dict, args) -> str:
    reasoning = (u.get("completion_tokens_details") or {}).get("reasoning_tokens")
    return f"in {ktok(u.get('prompt_tokens'))}, out {ktok(u.get('completion_tokens'))}, reasoning {ktok(reasoning)}, {money(actual_cost(u, args))}"


def rates(text: str):
    try:
        a, b = (float(x) for x in text.split(","))
        return a, b
    except ValueError:
        raise argparse.ArgumentTypeError("expected IN,OUT dollars per million tokens, for example 2,10")


def pretty_range(values) -> str:
    lo, hi = min(values), max(values)
    return ktok(lo) if ktok(lo) == ktok(hi) else f"{ktok(lo)}\u2013{ktok(hi)}"


def countdown(count: int, est: float, baseline_total: float):
    """30 seconds before the first request. Ctrl-C leaves with code 130 and nothing sent."""
    tty = sys.stdout.isatty()
    noun = "slice" if count == 1 else "slices"
    try:
        for left in range(COUNTDOWN_SECONDS, 0, -1):
            line = f"sending {count} {noun} in {left}s \u2014 est {money(est)} (baseline {money(baseline_total)}, {est / baseline_total:.1f}x) \u2014 Ctrl-C to cancel"
            if tty:
                print(f"\r{line}\x1b[K", end="", flush=True)
            elif left % 5 == 0:
                print(line, flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        print(("\n" if tty else "") + "cancelled, nothing sent", flush=True)
        sys.exit(130)
    if tty:
        print(flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tasks", type=Path, help="tasks file defining REPOS and TASKS")
    ap.add_argument("--model", required=True, help="exact provider model id")
    ap.add_argument("--effort", required=True, choices=["none", "low", "medium", "high"], help="reasoning.effort; none sends no reasoning field")
    ap.add_argument("--rates", type=rates, help="IN,OUT dollars per million tokens; overrides the live OpenRouter price, required for any other endpoint")
    ap.add_argument("--expect-out", required=True, type=int, help="expected tokens out per slice, file plus thinking, from the run ledger")
    ap.add_argument("--baseline", required=True, type=float, help="baseline dollars per slice from the run ledger")
    ap.add_argument("--accept-multiple", type=float, default=MAX_MULTIPLE, help="the user's approved multiple of the baseline")
    ap.add_argument("--max-tokens", type=int, default=64000)
    ap.add_argument("--endpoint", default=OPENROUTER_ENDPOINT)
    ap.add_argument("--key-env", default="OPENROUTER_API_KEY")
    ap.add_argument("--output", type=Path, help="default: <tasks file stem>_out beside the tasks file")
    ap.add_argument("--only", help="comma-separated slice ids")
    ap.add_argument("--dry-run", action="store_true", help="write prompts, print the cost screen, send nothing")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)
    signal.signal(signal.SIGINT, signal.default_int_handler)  # a shell may start us with SIGINT ignored; Ctrl-C must still cancel

    if args.rates:
        args.rate_in, args.rate_out = args.rates
        rate_note, reasoning_rate = "from --rates", None
    elif args.endpoint == OPENROUTER_ENDPOINT:
        args.rate_in, args.rate_out, reasoning_rate = fetch_rates(args.model)
        rate_note = f"from openrouter.ai/api/v1/models at {datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S}Z"
    else:
        fail(f"{args.endpoint} is not OpenRouter, so there is no live price list; pass --rates IN,OUT")
    if reasoning_rate and reasoning_rate > args.rate_out:
        args.rate_out = reasoning_rate  # thinking is billed as output; price expected output at the higher rate

    repos, all_tasks, system = load_tasks(args.tasks.resolve())
    out = (args.output or args.tasks.resolve().with_name(args.tasks.stem + "_out")).resolve()
    ids = args.only.split(",") if args.only else None
    tasks = [t for t in all_tasks if ids is None or t["custom_id"] in ids]
    if not tasks:
        fail(f"--only matched nothing; ids: {', '.join(t['custom_id'] for t in all_tasks)}")

    parts = {t["custom_id"]: context_parts(repos, t) for t in tasks}  # fails on a missing or over-cap context entry
    prompts = {t["custom_id"]: build_prompt(parts[t["custom_id"]], t) for t in tasks}
    estimates = {cid: estimate(p, args) for cid, p in prompts.items()}
    total, baseline_total = sum(estimates.values()), args.baseline * len(tasks)
    worst = max(e / args.baseline for e in estimates.values())

    print(f"model {args.model} at {args.endpoint}, effort {args.effort}, max_tokens {args.max_tokens}")
    reasoning_text = f", thinking ${reasoning_rate:g}" if reasoning_rate is not None else ""
    print(f"rates ${args.rate_in:g} in / ${args.rate_out:g} out per million tokens{reasoning_text} {rate_note}")
    for t in tasks:
        cid = t["custom_id"]
        print(f"  {cid}: returns {', '.join(t['output_files'])}")
        for label, _, size in parts[cid]:
            print(f"    {label}: {size:,} bytes, ~{size // 4:,} tokens")
        print(f"    prompt ~{tokens_of(prompts[cid]):,} tokens in, expect {args.expect_out:,} out, est {money(estimates[cid])} ({estimates[cid] / args.baseline:.1f}x baseline)")
    tokens_in = sum(tokens_of(p) for p in prompts.values())
    print(
        f"batch: {len(tasks)} slice(s), ~{tokens_in:,} tokens in, est {money(total)}, baseline {money(baseline_total)}, "
        f"worst {worst:.1f}x, model {args.model}, effort {args.effort}, max_tokens {args.max_tokens}"
    )

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
    countdown(len(tasks), total, baseline_total)

    pending = set(prompts)
    started = time.time()
    done = threading.Event()

    def ticker():
        while not done.wait(20):
            print(f"  ... {time.time() - started:4.0f}s  waiting on: {', '.join(sorted(pending))}", flush=True)

    threading.Thread(target=ticker, daemon=True).start()
    failed, results, running = [], [], 0.0
    with ThreadPoolExecutor(max_workers=min(len(tasks), 16)) as pool:
        futures = []
        for t in tasks:
            print(f"  sent {t['custom_id']}", flush=True)
            futures.append(pool.submit(run_task, args, key, system, prompts[t["custom_id"]], t, out, repos))
        for fut in as_completed(futures):
            r = fut.result()
            cid = r["task"]["custom_id"]
            pending.discard(cid)
            results.append(r)
            running += actual_cost(r["usage"], args)
            tail = f"{usage_line(r['usage'], args)} (est {money(estimates[cid])}) \u2014 total {money(running)} of est {money(total)}"
            if r["ok"]:
                print(f"  ok   {cid}: {r['seconds']:.0f}s, {tail}, lines {r['lines']}", flush=True)
            else:
                print(f"  FAIL {cid}: {r['error']} ({tail})", flush=True)
                failed.append(cid)
    done.set()
    print(f"done in {time.time() - started:.0f}s; usage per slice in {out / '_returns'}")

    actual = running
    per_slice = {r["task"]["custom_id"]: actual_cost(r["usage"], args) for r in results}
    multiples = ", ".join(f"{cid} {c / args.baseline:.1f}x" for cid, c in sorted(per_slice.items()))
    print(f"actual {money(actual)}, estimated {money(total)}, baseline {money(baseline_total)}; actual {actual / baseline_total:.1f}x baseline ({multiples})")
    pst = datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")
    billed_in = [r["usage"].get("prompt_tokens") for r in results if r["usage"].get("prompt_tokens")]
    returned = [r["returned_tokens"] for r in results if r["returned_tokens"]]
    whole = sum(1 for r in results if r["ok"])
    names = ", ".join(sorted({p.name for p in repos.values()}))
    print("ledger row (references/runs.md):")
    print(
        f"| {pst} | {names} \u00b7 `{args.tasks.name}` | `{args.model}` | {len(results)} | "
        f"{pretty_range(billed_in) if billed_in else 'n/a'} | {pretty_range(returned) if returned else 'n/a'} | "
        f"{money(total)} | **actual {money(actual)}** ({money(actual / len(results))} per slice) | {whole} of {len(tasks)} whole |"
    )
    if failed:
        print(f"failed: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
