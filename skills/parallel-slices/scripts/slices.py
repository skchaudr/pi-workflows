#!/usr/bin/env python3
"""The one dispatch engine for parallel slices. Do not copy it into a task; give it a tasks file.

  slices send TASKS.py --model M --effort low --expect-out 15000 --baseline 0.17 --dry-run
  slices send TASKS.py ...same flags... --only id1,id2          # pilot or retry
  slices send TASKS.py ...same flags...                          # send

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
A finished send appends one line to runs.jsonl in the state directory.
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


USAGE = """usage: slices <command> ...

  send TASKS.py ...   dry run or send a batch: cost screen, 30 s countdown, run record
  show TASKS.py ...   the cost screen only; sends nothing, writes nothing
  runs                recorded runs, newest first
  status RUN          per-slice result of a run: a tasks file, its _out dir, or an index from `runs` (1 = newest)
  ledger              the run ledger (references/runs.md)

Run records go to runs.jsonl in $SLICES_STATE_DIR (default ~/.local/state/slices).
`slices send --help` lists the send flags."""


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
        short = f"{rel}#L{a}-{b}"
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
            return {**result, "ok": False, "error": f"cut off at {args.max_tokens:,} out; partial in {ret}"}
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


def k1(n) -> str:
    if not isinstance(n, (int, float)):
        return "\u2013"
    return str(int(n)) if n < 1000 else f"{n / 1000:.1f}k"


def rates(text: str):
    try:
        a, b = (float(x) for x in text.split(","))
        return a, b
    except ValueError:
        raise argparse.ArgumentTypeError("expected IN,OUT dollars per million tokens, for example 2,10")


def pretty_range(values) -> str:
    lo, hi = min(values), max(values)
    return ktok(lo) if ktok(lo) == ktok(hi) else f"{ktok(lo)}\u2013{ktok(hi)}"


TTY = sys.stdout.isatty()


CODES = {"bold": "1", "dim": "2", "red": "31", "green": "32", "yellow": "33", "blue": "34", "magenta": "35", "cyan": "36"}


def paint(text: str, *styles: str) -> str:
    """Wrap text in ANSI styles when stdout is a terminal; pad before painting so columns stay aligned."""
    if not TTY or not styles:
        return text
    return f"\x1b[{';'.join(CODES[x] for x in styles)}m{text}\x1b[0m"


def dim(text: str) -> str:
    return paint(text, "dim")


def red(text: str) -> str:
    return paint(text, "red")


def multiple_style(multiple: float) -> str:
    """Green at or under the baseline, yellow up to the 2x limit, red past it."""
    return "green" if multiple <= 1.0 else "yellow" if multiple <= MAX_MULTIPLE else "red"


def plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def times(multiple: float) -> str:
    return f"{multiple:.1f}\u00d7"


def print_screen(args, tasks, parts, prompts, estimates, source, show_files):
    """The cost screen: one header line, one row per slice, a total row against the baseline."""
    print(paint(args.model, "bold", "cyan"))
    print(
        dim(
            f"effort {args.effort} \u00b7 max out {args.max_tokens:,} \u00b7 "
            f"${args.rate_in:g} in / ${args.rate_out:g} out per M \u00b7 {source}"
        )
    )
    print()
    total, baseline_total = sum(estimates.values()), args.baseline * len(tasks)
    sizes = {t["custom_id"]: sum(n for _, _, n in parts[t["custom_id"]]) for t in tasks}
    # name, files, KB, in, out, est, multiple
    rows = [
        [t["custom_id"], plural(len(parts[t["custom_id"]]), "file"), f"{sizes[t['custom_id']] / 1024:.0f} KB",
         k1(tokens_of(prompts[t["custom_id"]])), k1(args.expect_out), money(estimates[t["custom_id"]]),
         estimates[t["custom_id"]] / args.baseline]
        for t in tasks
    ]
    total_row = [
        plural(len(tasks), "slice"), plural(sum(len(parts[t["custom_id"]]) for t in tasks), "file"),
        f"{sum(sizes.values()) / 1024:.0f} KB", k1(sum(tokens_of(p) for p in prompts.values())),
        k1(args.expect_out * len(tasks)), money(total), total / baseline_total,
    ]
    everything = rows + [total_row]
    head = ["slice", "", "", "in", "out", "est", "\u00d7 base"]
    wn = max(len(r[0]) for r in everything + [head])
    wf, wk = max(len(r[1]) for r in everything), max(len(r[2]) for r in everything)
    wc = max(wf + 2 + wk, len("context"))
    wi, wo, we = (max(len(r[i]) for r in everything + [head]) for i in (3, 4, 5))
    wm = max(max(len(times(r[6])) for r in everything), len(head[6]))

    def line(row, header=False, total=False):
        if header:
            cells = [row[0].ljust(wn), "context".ljust(wc), row[3].rjust(wi), row[4].rjust(wo), row[5].rjust(we), row[6].rjust(wm)]
            return "  " + "   ".join(dim(c) for c in cells).replace(dim(cells[0]) + "   ", dim(cells[0]) + "  ", 1)
        name = paint(row[0].ljust(wn), "bold")
        ctx = dim(row[1].ljust(wf) + "  " + row[2].rjust(wk)).ljust(wc + (len(dim("")) if TTY else 0))
        weight = ("bold",) if total else ()
        cells = [
            paint(row[3].rjust(wi), *weight, "cyan"),
            paint(row[4].rjust(wo), *weight, "magenta"),
            paint(row[5].rjust(we), "bold"),
            paint(times(row[6]).rjust(wm), "bold", multiple_style(row[6])),
        ]
        return f"  {name}  {ctx}   " + "   ".join(cells)

    header = line(head, header=True)
    print(header)
    for row, t in zip(rows, tasks):
        print(line(row))
        if show_files:
            entries = [(e.split(":", 1)[1], n) for e, (_, _, n) in zip(t.get("context_files", []), parts[t["custom_id"]])]
            pad = max((len(e) for e, _ in entries), default=0)
            for e, n in entries:
                print(dim(f"    {e.ljust(pad)}   {n / 1024:.1f} KB"))
    print(dim("  " + "\u2500" * (wn + 2 + wc + 3 + wi + 3 + wo + 3 + we + 3 + wm)))
    print(line(total_row, total=True) + dim(f"   baseline {money(baseline_total)}"))
    return total, baseline_total


def countdown(est: float):
    """30 seconds before the first request. Ctrl-C leaves with code 130 and nothing sent."""
    try:
        for left in range(COUNTDOWN_SECONDS, 0, -1):
            line = f"Sending in {left}s \u00b7 est {money(est)} \u00b7 Ctrl-C to cancel"
            if TTY:
                print(f"\r{paint(f'Sending in {left}s', 'bold', 'yellow')}{dim(f' \u00b7 est {money(est)} \u00b7 Ctrl-C to cancel')}\x1b[K", end="", flush=True)
            elif left % 10 == 0:
                print(line, flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        print(("\n" if TTY else "") + paint("Cancelled", "bold", "yellow") + dim(" \u00b7 nothing sent"), flush=True)
        sys.exit(130)
    if TTY:
        print(flush=True)


def result_line(ok, cid, name_w, seconds, prompt, completion, think, error, cost, est):
    """One slice's result up to its cost and estimate; the caller appends what follows (running total or return path)."""
    if ok:
        mark = paint("✓", "bold", "green")
        body = (
            paint(f"{k1(prompt):>6} in", "cyan") + "   "
            + paint(f"{k1(completion):>6} out", "magenta") + "   "
            + dim(f"{k1(think):>6} think")
        )
    else:
        mark = paint("✗", "bold", "red")
        body = paint(" ".join(str(error).split()).ljust(38), "red")
    est_text = money(est) if isinstance(est, (int, float)) else "–"
    return (
        f"  {mark} {paint(cid.ljust(name_w), 'bold')}   {dim(f'{seconds:>3.0f}s')}   {body}   "
        f"{paint(money(cost) if isinstance(cost, (int, float)) else chr(0x2013), 'bold')}  {dim(f'(est {est_text})')}"
    )


def state_dir() -> Path:
    return Path(os.environ.get("SLICES_STATE_DIR") or Path.home() / ".local" / "state" / "slices")


def read_runs():
    """Recorded runs, newest first. Reads only; the directory is not created."""
    path = state_dir() / "runs.jsonl"
    if not path.is_file():
        return []
    runs = []
    for n, text in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not text.strip():
            continue
        try:
            runs.append(json.loads(text))
        except json.JSONDecodeError as e:
            fail(f"{path} line {n} is not JSON ({e}); fix or remove that line")
    return runs[::-1]


def record_run(record: dict) -> Path:
    path = state_dir() / "runs.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")
    return path


def pst_stamp(iso: str) -> str:
    return datetime.fromisoformat(iso).astimezone(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d %H:%M")


def render_table(header, rows, right=(), style=None):
    """Aligned columns, a dim header, two-space indent; style(col, padded_cell) may colour a cell after padding."""
    widths = [max(len(str(r[c])) for r in rows + [header]) for c in range(len(header))]

    def pad(c, text):
        return str(text).rjust(widths[c]) if c in right else str(text).ljust(widths[c])

    lines = ["  " + "   ".join(dim(pad(c, h)) for c, h in enumerate(header)).rstrip()]
    for r in rows:
        cells = [pad(c, v) for c, v in enumerate(r)]
        if style:
            cells = [style(c, v) for c, v in enumerate(cells)]
        lines.append("  " + "   ".join(cells).rstrip())
    return lines


def multiple_of(actual, baseline):
    return actual / baseline if baseline else 0.0


def cmd_runs(argv):
    argparse.ArgumentParser(prog="slices runs", description="One row per recorded run, newest first.").parse_args(argv)
    runs = read_runs()
    if not runs:
        print(dim(f"no runs recorded in {state_dir() / 'runs.jsonl'}"))
        return 0
    rows = []
    for i, r in enumerate(runs, 1):
        t = r["totals"]
        whole = sum(1 for s in r["slices"] if s["ok"])
        rows.append([
            str(i), pst_stamp(r["startedAt"]), Path(r["tasksPath"]).name, r["model"], str(len(r["slices"])),
            f"{whole}/{len(r['slices'])}", money(t["actual"]), money(t["est"]), money(t["baseline"]),
            times(multiple_of(t["actual"], t["baseline"])),
        ])

    def style(col, cell):
        if col == 3:
            return paint(cell, "bold", "cyan")
        if col == 5:
            a, b = cell.strip().split("/")
            return paint(cell, "green" if a == b else "red")
        if col == 6:
            return paint(cell, "bold")
        if col == 9:
            return paint(cell, "bold", multiple_style(float(cell.strip()[:-1])))
        return cell

    header = ["#", "date (PST)", "tasks", "model", "slices", "whole", "actual", "est", "baseline", "×"]
    print("\n".join(render_table(header, rows, right={0, 4, 5, 6, 7, 8, 9}, style=style)))
    return 0


def usage_fallback(out: Path):
    """Rebuild a run from the saved <id>.usage.json files when no record exists."""
    returns = out / "_returns"
    files = sorted(returns.glob("*.usage.json")) if returns.is_dir() else []
    if not files:
        fail(f"no run record and no usage files in {returns}")
    slices, model, effort = [], None, None
    for f in files:
        rec = json.loads(f.read_text(encoding="utf-8"))
        u = rec.get("usage") or {}
        cid = f.name[: -len(".usage.json")]
        ret = returns / f"{cid}.md"
        cut = str(rec.get("finish", "")).lower() in ("length", "max_tokens")
        empty = not ret.is_file() or not ret.read_text(encoding="utf-8").strip()
        slices.append({
            "id": cid, "ok": not cut and not empty,
            "error": "cut off at the output cap" if cut else ("empty return" if empty else None),
            "seconds": rec.get("seconds") or 0, "promptTokens": u.get("prompt_tokens"),
            "completionTokens": u.get("completion_tokens"),
            "reasoningTokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "cost": u.get("cost"), "est": None,
        })
        model, effort = model or rec.get("model"), effort or rec.get("effort")
    return {"model": model, "effort": effort, "slices": slices, "outDir": str(out), "fromUsage": True}


def cmd_status(argv):
    ap = argparse.ArgumentParser(prog="slices status", description="Per-slice result of one run.")
    ap.add_argument("run", help="a tasks file, its _out directory, or the index shown by `slices runs` (1 = newest)")
    ref = ap.parse_args(argv).run
    runs = read_runs()
    record = None
    if ref.isdigit() and not Path(ref).exists():
        if not 1 <= int(ref) <= len(runs):
            fail(f"no run {ref}; `slices runs` lists {len(runs)}")
        record = runs[int(ref) - 1]
        out = Path(record["outDir"])
    else:
        p = Path(ref).expanduser().resolve()
        if p.is_file():
            out = p.with_name(p.stem + "_out")
            record = next((r for r in runs if Path(r["tasksPath"]).resolve() == p), None)
        elif p.is_dir():
            out = p
        else:
            fail(f"{ref} is not a tasks file, an _out directory or a run index")
        record = record or next((r for r in runs if Path(r["outDir"]).resolve() == out), None)
    record = record or usage_fallback(out)
    slices = record["slices"]

    print(paint(str(record["model"]), "bold", "cyan"))
    bits = [f"effort {record['effort']}"]
    if record.get("startedAt"):
        bits.append(pst_stamp(record["startedAt"]) + " PST")
    if record.get("maxTokens"):
        bits.append(f"max out {record['maxTokens']:,}")
    if record.get("fromUsage"):
        bits.append("no run record, rebuilt from usage files")
    print(dim(" · ".join(bits)))
    print()
    name_w = max(len(s["id"]) for s in slices)
    for s in slices:
        ret = Path(record["outDir"]) / "_returns" / f"{s['id']}.md"
        print(
            result_line(s["ok"], s["id"], name_w, s["seconds"], s["promptTokens"], s["completionTokens"],
                        s["reasoningTokens"], s.get("error"), s["cost"], s["est"])
            + "   " + dim(str(ret))
        )
    print()
    whole = sum(1 for s in slices if s["ok"])
    actual = sum(s["cost"] for s in slices if isinstance(s["cost"], (int, float)))
    line = paint(f"{whole} of {len(slices)} whole", "bold", "green" if whole == len(slices) else "red")
    line += dim(" · actual ") + paint(money(actual), "bold")
    totals = record.get("totals")
    if totals:
        multiple = multiple_of(totals["actual"], totals["baseline"])
        line += dim(f" · est {money(totals['est'])} · baseline {money(totals['baseline'])} · ")
        line += paint(times(multiple), "bold", multiple_style(multiple))
    print(line)
    return 0


def cmd_ledger(argv):
    argparse.ArgumentParser(prog="slices ledger", description="The run ledger from references/runs.md, aligned.").parse_args(argv)
    path = Path(__file__).resolve().parent.parent / "references" / "runs.md"
    if not path.is_file():
        fail(f"ledger not found: {path}")
    table = [
        [c.strip().replace("`", "").replace("**", "") for c in line.strip().strip("|").split("|")]
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.startswith("|")
    ]
    table = [row for row in table if not all(set(c) <= set("-: ") for c in row)]
    if not table:
        fail(f"no table in {path}")
    print("\n".join(render_table(table[0], table[1:])))
    return 0


def build_parser(command: str):
    sending = command == "send"
    ap = argparse.ArgumentParser(
        prog=f"slices {command}",
        description=__doc__ if sending else "The cost screen for a tasks file with the same flags as send; sends nothing and writes nothing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("tasks", type=Path, help="tasks file defining REPOS and TASKS")
    ap.add_argument("--model", required=True, help="exact provider model id")
    ap.add_argument("--effort", required=True, choices=["none", "low", "medium", "high"], help="reasoning.effort; none sends no reasoning field")
    ap.add_argument("--rates", type=rates, help="IN,OUT dollars per million tokens; overrides the live OpenRouter price, required for any other endpoint")
    ap.add_argument("--expect-out", required=True, type=int, help="expected tokens out per slice, file plus thinking, from the run ledger")
    ap.add_argument("--baseline", required=True, type=float, help="baseline dollars per slice from the run ledger")
    ap.add_argument("--max-tokens", type=int, default=64000)
    ap.add_argument("--endpoint", default=OPENROUTER_ENDPOINT)
    ap.add_argument("--only", help="comma-separated slice ids")
    if sending:
        ap.add_argument("--accept-multiple", type=float, default=MAX_MULTIPLE, help="the user's approved multiple of the baseline")
        ap.add_argument("--key-env", default="OPENROUTER_API_KEY")
        ap.add_argument("--output", type=Path, help="default: <tasks file stem>_out beside the tasks file")
        ap.add_argument("--files", action="store_true", help="list each slice's context files when sending (a dry run always lists them)")
        ap.add_argument("--dry-run", action="store_true", help="write prompts, print the cost screen, send nothing")
    return ap


def prepare(args):
    """Rates, tasks and prompts for send and show. Writes nothing; reads the price list only when no --rates is given."""
    args.rate_think = None
    if args.rates:
        args.rate_in, args.rate_out = args.rates
        args.rate_out_listed = args.rate_out
        source = "--rates" if args.endpoint == OPENROUTER_ENDPOINT else f"--rates · {args.endpoint}"
    elif args.endpoint == OPENROUTER_ENDPOINT:
        args.rate_in, args.rate_out, args.rate_think = fetch_rates(args.model)
        args.rate_out_listed = args.rate_out
        source = f"OpenRouter {datetime.now(timezone.utc):%H:%M}Z"
        if args.rate_think and args.rate_think > args.rate_out:
            args.rate_out = args.rate_think  # thinking is billed as output; price expected output at the higher rate
    else:
        fail(f"{args.endpoint} is not OpenRouter, so there is no live price list; pass --rates IN,OUT")

    repos, all_tasks, system = load_tasks(args.tasks.resolve())
    out = (getattr(args, "output", None) or args.tasks.resolve().with_name(args.tasks.stem + "_out")).resolve()
    ids = args.only.split(",") if args.only else None
    tasks = [t for t in all_tasks if ids is None or t["custom_id"] in ids]
    if not tasks:
        fail(f"--only matched nothing; ids: {', '.join(t['custom_id'] for t in all_tasks)}")

    parts = {t["custom_id"]: context_parts(repos, t) for t in tasks}  # fails on a missing or over-cap context entry
    prompts = {t["custom_id"]: build_prompt(parts[t["custom_id"]], t) for t in tasks}
    estimates = {cid: estimate(p, args) for cid, p in prompts.items()}
    return repos, system, out, tasks, parts, prompts, estimates, source


def cmd_show(argv):
    args = build_parser("show").parse_args(argv)
    _, _, _, tasks, parts, prompts, estimates, source = prepare(args)
    print_screen(args, tasks, parts, prompts, estimates, source, True)
    return 0


def cmd_send(argv):
    args = build_parser("send").parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)
    signal.signal(signal.SIGINT, signal.default_int_handler)  # a shell may start us with SIGINT ignored; Ctrl-C must still cancel

    repos, system, out, tasks, parts, prompts, estimates, source = prepare(args)
    worst = max(e / args.baseline for e in estimates.values())

    total, baseline_total = print_screen(args, tasks, parts, prompts, estimates, source, args.dry_run or args.files)
    print()

    if args.dry_run:
        for cid, prompt in prompts.items():
            p = out / "_prompts" / f"{cid}.md"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(prompt, encoding="utf-8")
        print(paint("Dry run", "bold", "yellow") + dim(f" · prompts in {out / '_prompts'} · nothing sent"))
        return 0
    if worst > args.accept_multiple:
        fail(f"worst slice is {worst:.1f}x the baseline; the user must approve that multiple (--accept-multiple {worst:.1f}) before sending")
    key = os.environ.get(args.key_env)
    if not key:
        fail(f"{args.key_env} is not set")
    countdown(total)

    pending = set(prompts)
    started = time.time()
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    done = threading.Event()

    def ticker():
        while not done.wait(20):
            print(dim(f"  … {time.time() - started:.0f}s · waiting on {', '.join(sorted(pending))}"), flush=True)

    threading.Thread(target=ticker, daemon=True).start()
    name_w = max(len(t["custom_id"]) for t in tasks)
    failed, results, running = [], [], 0.0
    with ThreadPoolExecutor(max_workers=min(len(tasks), 16)) as pool:
        futures = [pool.submit(run_task, args, key, system, prompts[t["custom_id"]], t, out, repos) for t in tasks]
        for fut in as_completed(futures):
            r = fut.result()
            cid = r["task"]["custom_id"]
            pending.discard(cid)
            results.append(r)
            cost = actual_cost(r["usage"], args)
            running += cost
            u = r["usage"]
            think = (u.get("completion_tokens_details") or {}).get("reasoning_tokens")
            if not r["ok"]:
                failed.append(cid)
            print(
                result_line(r["ok"], cid, name_w, r["seconds"], u.get("prompt_tokens"), u.get("completion_tokens"),
                            think, r.get("error"), cost, estimates[cid])
                + f"   {dim('total')} {paint(money(running), 'bold')}",
                flush=True,
            )
    done.set()
    finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    actual = running
    multiple = actual / baseline_total
    mult_text = times(multiple)
    print()
    whole_count = sum(1 for r in results if r["ok"])
    print(
        paint(f"Done in {time.time() - started:.0f}s", "bold")
        + dim(" · ")
        + paint(f"{whole_count} of {len(tasks)} whole", "bold", "green" if whole_count == len(tasks) else "red")
        + dim(" · actual ")
        + paint(money(actual), "bold")
        + dim(f" · est {money(total)} · baseline {money(baseline_total)} · ")
        + paint(mult_text, "bold", multiple_style(multiple))
    )
    pst = datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d")
    billed_in = [r["usage"].get("prompt_tokens") for r in results if r["usage"].get("prompt_tokens")]
    returned = [r["returned_tokens"] for r in results if r["returned_tokens"]]
    whole = sum(1 for r in results if r["ok"])
    names = ", ".join(sorted({p.name for p in repos.values()}))
    print(paint("Ledger row:", "bold"))
    print(
        f"| {pst} | {names} · `{args.tasks.name}` | `{args.model}` | {len(results)} | "
        f"{pretty_range(billed_in) if billed_in else 'n/a'} | {pretty_range(returned) if returned else 'n/a'} | "
        f"{money(total)} | **actual {money(actual)}** ({money(actual / len(results))} per slice) | {whole} of {len(tasks)} whole |"
    )

    by_id = {r["task"]["custom_id"]: r for r in results}
    slice_records = []
    for t in tasks:
        r = by_id[t["custom_id"]]
        u = r["usage"]
        item = {"id": t["custom_id"], "ok": r["ok"]}
        if not r["ok"]:
            item["error"] = r["error"]
        item.update({
            "seconds": round(r["seconds"], 1), "promptTokens": u.get("prompt_tokens"),
            "completionTokens": u.get("completion_tokens"),
            "reasoningTokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "cost": actual_cost(u, args), "est": estimates[t["custom_id"]],
        })
        slice_records.append(item)
    record_run({
        "schema": "slices.run.v1", "startedAt": started_at, "finishedAt": finished_at,
        "tasksPath": str(args.tasks.resolve()), "outDir": str(out), "model": args.model, "effort": args.effort,
        "maxTokens": args.max_tokens,
        "rates": {"in": args.rate_in, "out": args.rate_out_listed, "think": args.rate_think, "source": source},
        "baselinePerSlice": args.baseline, "slices": slice_records,
        "totals": {"actual": actual, "est": total, "baseline": baseline_total},
    })
    print(dim(f"Usage files in {out / '_returns'} · run recorded in {state_dir() / 'runs.jsonl'}"))
    return 1 if failed else 0


COMMANDS = {"send": cmd_send, "show": cmd_show, "runs": cmd_runs, "status": cmd_status, "ledger": cmd_ledger}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] in ("-h", "--help"):
        print(USAGE)
        return 0
    if not argv or argv[0] not in COMMANDS:
        print(USAGE, file=sys.stderr)
        return 2
    sys.stdout.reconfigure(line_buffering=True)
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main())
