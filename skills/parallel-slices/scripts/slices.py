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
import argparse, importlib.util, json, os, re, shutil, signal, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request
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

  acp TASKS.py ...    dry-render ACP packets or send ONE slice via acpx -> agy acp (Neon medium)
  send TASKS.py ...   dry run or send a batch: cost screen, 30 s countdown, run record
  show TASKS.py ...   the cost screen only; sends nothing, writes nothing
  runs                recorded runs, newest first
  status RUN          per-slice result of a run: a tasks file, its _out dir, or an index from `runs` (1 = newest)
  ledger              the run ledger (references/runs.md)

Run records go to runs.jsonl in $SLICES_STATE_DIR (default ~/.local/state/slices).
`slices acp --help` and `slices send --help` list the command flags."""


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


def build_acp_packet(system: str, parts, task) -> str:
    return f"{system.strip()}\n\n{build_prompt(parts, task)}"


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


def build_acp_parser():
    ap = argparse.ArgumentParser(
        prog="slices acp",
        description=(
            "Render self-contained ACP packets (SYSTEM + REPOSITORY CONTEXT + TASK SPECIFICATION) "
            "or send ONE rendered packet through `acpx --agent 'agy acp --sandbox'` from an empty scratch directory."
        ),
    )
    ap.add_argument("tasks", type=Path, help="tasks file defining REPOS, SYSTEM, and TASKS")
    ap.add_argument("--only", help="single slice id to send (or comma-separated slice ids for --dry-run)")
    ap.add_argument("--model", default="gemini-4-neon", help="exact ACP model id (default: gemini-4-neon)")
    ap.add_argument(
        "--thought-level",
        default="medium",
        choices=["low", "medium", "high", "xhigh"],
        help="ACP thought_level config option (default: medium)",
    )
    ap.add_argument(
        "--agent",
        default="agy acp --sandbox",
        help="ACP agent command passed to acpx --agent (default: 'agy acp --sandbox')",
    )
    ap.add_argument("--timeout", type=int, default=360, help="acpx timeout in seconds (default: 360)")
    ap.add_argument("--output", type=Path, help="default: <tasks file stem>_out beside the tasks file")
    ap.add_argument("--dry-run", action="store_true", help="render packet files locally and send nothing")
    ap.add_argument(
        "--rex",
        action="store_true",
        help="launch the single-slice ACP run in a named Rex pane with --keep-open",
    )
    ap.add_argument("--rex-label", help="override the Rex pane label (default: slice-<id>)")
    ap.add_argument(
        "--replay-events",
        type=Path,
        help="offline verification: replay a saved ACP JSONL event stream instead of invoking acpx",
    )
    return ap


def print_acp_packets_screen(args, repos, tasks, parts, packets, out: Path):
    print(paint(f"{args.model} · thought_level={args.thought_level}", "bold", "cyan"))
    print(dim(f"agent: {args.agent} · output: {out}"))
    print()
    rows = []
    total_ctx_bytes = 0
    total_pkt_bytes = 0
    total_files = 0
    for t in tasks:
        cid = t["custom_id"]
        ctx_bytes = sum(n for _, _, n in parts[cid])
        pkt_bytes = len(packets[cid].encode("utf-8"))
        n_files = len(parts[cid])
        targets = ", ".join(locate(repos, e)[1] for e in t["output_files"])
        total_ctx_bytes += ctx_bytes
        total_pkt_bytes += pkt_bytes
        total_files += n_files
        rows.append([
            cid,
            plural(n_files, "file"),
            f"{ctx_bytes / 1024:.1f} KB",
            f"{pkt_bytes / 1024:.1f} KB",
            k1(tokens_of(packets[cid])),
            targets,
        ])
    total_row = [
        plural(len(tasks), "slice"),
        plural(total_files, "file"),
        f"{total_ctx_bytes / 1024:.1f} KB",
        f"{total_pkt_bytes / 1024:.1f} KB",
        k1(sum(tokens_of(p) for p in packets.values())),
        "",
    ]
    header = ["slice", "excerpts", "ctx KB", "packet KB", "est in", "target"]
    print("\n".join(render_table(header, rows + [total_row], right={1, 2, 3, 4})))


def process_acp_event_stream(
    lines_iter,
    *,
    cid: str,
    args,
    wanted: dict,
    out: Path,
    raw_events_path: Path,
    raw_return_path: Path,
    usage_path: Path,
    start_time: float,
):
    raw_events_path.parent.mkdir(parents=True, exist_ok=True)
    effective_config = {}
    legacy_current_model = None
    tier_name = None
    quota_pct = "unknown"
    thought_chunks = 0
    thought_chars = 0
    last_thought_headline = ""
    first_code_at = None
    in_code_stream = False
    tool_calls = []
    raw_message_chunks = []
    rpc_errors = []
    stop_reason = None
    usage = {}
    thinking_active = threading.Event()
    thinking_stop = threading.Event()
    state_lock = threading.Lock()

    def clear_thinking_line():
        if TTY:
            sys.stdout.write("\r\x1b[K")
            sys.stdout.flush()

    def ticker():
        while not thinking_stop.wait(1.0):
            if not thinking_active.is_set() or in_code_stream:
                continue
            with state_lock:
                elapsed = time.time() - start_time
                headline = last_thought_headline
                chunks = thought_chunks
            if TTY:
                badge = paint("THINKING", "bold", "yellow")
                tail = f" · {headline}" if headline else ""
                sys.stdout.write(
                    f"\r  {badge}  {dim(f'{elapsed:5.1f}s · {chunks} chunks')}{dim(tail[:72])}\x1b[K"
                )
                sys.stdout.flush()

    ticker_thread = threading.Thread(target=ticker, daemon=True)
    ticker_thread.start()

    def update_config_from_list(cfg_list):
        if not isinstance(cfg_list, list):
            return
        for item in cfg_list:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                val = item.get("currentValue")
                if isinstance(val, str):
                    effective_config[item["id"]] = val

    with raw_events_path.open("w", encoding="utf-8") as events_file:
        for raw_line in lines_iter:
            line = raw_line.rstrip("\r\n")
            if not line.strip():
                continue
            events_file.write(line + "\n")
            events_file.flush()
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue

            if "error" in msg and isinstance(msg["error"], dict):
                err_msg = msg["error"].get("message") or json.dumps(msg["error"])
                rpc_errors.append(str(err_msg))
                clear_thinking_line()
                print(f"  {paint('FAIL', 'bold', 'red')}      {paint(str(err_msg), 'red')}", flush=True)
                continue

            res = msg.get("result")
            if isinstance(res, dict):
                if "configOptions" in res:
                    update_config_from_list(res.get("configOptions"))
                models_obj = res.get("models")
                if isinstance(models_obj, dict) and isinstance(models_obj.get("currentModelId"), str):
                    legacy_current_model = models_obj["currentModelId"]
                meta_agy = (res.get("_meta") or {}).get("antigravity") if isinstance(res.get("_meta"), dict) else None
                if isinstance(meta_agy, dict):
                    tier = meta_agy.get("tier")
                    if isinstance(tier, dict) and isinstance(tier.get("name"), str):
                        tier_name = tier["name"]
                    for qk in ("quotaPercentage", "quotaRemainingPct", "remainingPercentage", "quota"):
                        if qk in meta_agy and meta_agy[qk] is not None:
                            quota_pct = str(meta_agy[qk])
                if isinstance(res.get("stopReason"), str):
                    stop_reason = res["stopReason"]
                if isinstance(res.get("usage"), dict):
                    usage.update(res["usage"])

            method = msg.get("method")
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

            if isinstance(method, str) and method.startswith(("fs/", "terminal/")):
                elapsed = time.time() - start_time
                tool_calls.append({"name": method, "elapsed": round(elapsed, 2)})
                clear_thinking_line()
                print(
                    f"  {paint('TOOL CALL', 'bold', 'red')} {dim(f'+{elapsed:5.1f}s')}  "
                    f"{paint(method, 'bold', 'red')}  {paint('[REJECTED: tool use forbidden]', 'red')}",
                    flush=True,
                )
                continue

            if method == "session/update":
                upd = params.get("update") if isinstance(params.get("update"), dict) else {}
                kind = upd.get("sessionUpdate")
                if kind == "config_option_update":
                    update_config_from_list(upd.get("configOptions"))
                    eff_m = effective_config.get("model", "?")
                    eff_t = effective_config.get("thought_level", "?")
                    clear_thinking_line()
                    print(
                        f"  {paint('CONFIG', 'bold', 'blue')}    model={paint(eff_m, 'bold')} · "
                        f"thought_level={paint(eff_t, 'bold')}"
                        + (f" · tier={tier_name}" if tier_name else ""),
                        flush=True,
                    )
                elif kind == "usage_update":
                    for qk in ("quotaPercentage", "quotaRemainingPct", "remainingPercentage"):
                        if qk in upd and upd[qk] is not None:
                            quota_pct = str(upd[qk])
                elif kind in ("tool_call", "tool_call_update"):
                    elapsed = time.time() - start_time
                    t_name = (
                        upd.get("name")
                        or upd.get("title")
                        or upd.get("kind")
                        or upd.get("toolCallId")
                        or kind
                    )
                    t_id = upd.get("toolCallId") or ""
                    if kind == "tool_call" or not any(tc.get("id") == t_id and t_id for tc in tool_calls):
                        tool_calls.append({"id": t_id, "name": str(t_name), "kind": kind, "elapsed": round(elapsed, 2)})
                    clear_thinking_line()
                    if in_code_stream:
                        print()
                        in_code_stream = False
                    print(
                        f"  {paint('TOOL CALL', 'bold', 'red')} {dim(f'+{elapsed:5.1f}s')}  "
                        f"{paint(str(t_name), 'bold', 'red')}  {paint('[REJECTED: tool use forbidden]', 'red')}",
                        flush=True,
                    )
                elif kind == "agent_thought_chunk":
                    text = ((upd.get("content") or {}).get("text") or "") if isinstance(upd.get("content"), dict) else ""
                    elapsed = time.time() - start_time
                    first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
                    with state_lock:
                        thought_chunks += 1
                        thought_chars += len(text)
                        if first_line:
                            last_thought_headline = first_line.strip("#*` ")
                        chunks_now = thought_chunks
                        headline_now = last_thought_headline
                    thinking_active.set()
                    if TTY:
                        badge = paint("THINKING", "bold", "yellow")
                        tail = f" · {headline_now}" if headline_now else ""
                        sys.stdout.write(
                            f"\r  {badge}  {dim(f'{elapsed:5.1f}s · {chunks_now} chunks')}{dim(tail[:72])}\x1b[K"
                        )
                        sys.stdout.flush()
                    elif chunks_now == 1 or chunks_now % 5 == 0:
                        tail = f"  {headline_now[:72]}" if headline_now else ""
                        print(f"  {paint('THINKING', 'bold', 'yellow')}  +{elapsed:5.1f}s  chunk {chunks_now}{tail}", flush=True)
                elif kind == "agent_message_chunk":
                    text = ((upd.get("content") or {}).get("text") or "") if isinstance(upd.get("content"), dict) else ""
                    if not text:
                        continue
                    raw_message_chunks.append(text)
                    if first_code_at is None:
                        first_code_at = time.time() - start_time
                        thinking_active.clear()
                        clear_thinking_line()
                        print(
                            f"  {paint('CODE', 'bold', 'cyan')}      "
                            f"{dim(f'first code at {first_code_at:.1f}s · streaming raw response')}",
                            flush=True,
                        )
                        in_code_stream = True
                    sys.stdout.write(text)
                    sys.stdout.flush()

    thinking_stop.set()
    clear_thinking_line()
    if in_code_stream:
        if not raw_message_chunks or not raw_message_chunks[-1].endswith("\n"):
            print()

    return {
        "effective_config": effective_config,
        "legacy_current_model": legacy_current_model,
        "tier_name": tier_name,
        "quota_pct": quota_pct,
        "thought_chunks": thought_chunks,
        "thought_chars": thought_chars,
        "first_code_at": first_code_at,
        "tool_calls": tool_calls,
        "raw_return": "".join(raw_message_chunks),
        "rpc_errors": rpc_errors,
        "stop_reason": stop_reason,
        "usage": usage,
    }


def cmd_acp(argv):
    args = build_acp_parser().parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)
    signal.signal(signal.SIGINT, signal.default_int_handler)

    repos, all_tasks, system = load_tasks(args.tasks.resolve())
    out = (args.output or args.tasks.resolve().with_name(args.tasks.stem + "_out")).resolve()
    ids = [x.strip() for x in args.only.split(",") if x.strip()] if args.only else None
    tasks = [t for t in all_tasks if ids is None or t["custom_id"] in ids]
    if not tasks:
        fail(f"--only matched nothing; ids: {', '.join(t['custom_id'] for t in all_tasks)}")

    parts = {t["custom_id"]: context_parts(repos, t) for t in tasks}
    packets = {t["custom_id"]: build_acp_packet(system, parts[t["custom_id"]], t) for t in tasks}

    for cid, packet in packets.items():
        for subdir in ("_prompts", "_packets"):
            p = out / subdir / f"{cid}.md"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(packet, encoding="utf-8")

    if args.dry_run:
        print_acp_packets_screen(args, repos, tasks, parts, packets, out)
        print()
        print(
            paint("Dry run", "bold", "yellow")
            + dim(f" · {len(packets)} ACP packets written to {out / '_prompts'} and {out / '_packets'} · nothing sent")
        )
        return 0

    if len(tasks) != 1:
        fail(
            f"ACP send dispatches exactly ONE slice per invocation (selected {len(tasks)}: "
            f"{', '.join(t['custom_id'] for t in tasks)}); pass --only <slice_id>"
        )

    task = tasks[0]
    cid = task["custom_id"]
    packet_path = out / "_packets" / f"{cid}.md"
    wanted = {}
    for e in task["output_files"]:
        repo, rel, _, _ = locate(repos, e)
        wanted[rel] = repo.name

    if args.rex:
        label = args.rex_label or f"slice-{cid}"
        inner = [
            sys.executable,
            str(Path(__file__).resolve()),
            "acp",
            str(args.tasks.resolve()),
            "--only",
            cid,
            "--model",
            args.model,
            "--thought-level",
            args.thought_level,
            "--agent",
            args.agent,
            "--timeout",
            str(args.timeout),
        ]
        if args.output:
            inner.extend(["--output", str(out)])
        rex_cmd = ["rex", "run", "--keep-open", "--label", label, "--", *inner]
        res = subprocess.run(rex_cmd, text=True, capture_output=True)
        if res.returncode != 0:
            fail(f"rex run failed (exit {res.returncode}): {res.stderr.strip() or res.stdout.strip()}")
        print(
            paint("Launched Rex pane", "bold", "green")
            + dim(f" · label={label} · {res.stdout.strip()}")
        )
        return 0

    ctx_bytes = sum(n for _, _, n in parts[cid])
    pkt_bytes = len(packets[cid].encode("utf-8"))
    targets_str = ", ".join(wanted.keys())
    scratch_root = Path(tempfile.mkdtemp(prefix=f"slices-acp-{cid}-"))
    work_dir = scratch_root / "work"
    work_dir.mkdir(parents=True, exist_ok=True)

    print(paint(f"━━ ACP SLICE · {cid} ", "bold", "cyan") + dim("━" * max(1, 56 - len(cid))))
    print(f"  {dim('target')}   {paint(targets_str, 'bold')}")
    print(
        f"  {dim('model')}    {paint(args.model, 'bold', 'cyan')} · "
        f"thought_level={paint(args.thought_level, 'bold', 'magenta')} · "
        f"agent={dim(args.agent)}"
    )
    print(
        f"  {dim('packet')}   {k1(tokens_of(packets[cid]))} est tokens "
        f"({pkt_bytes / 1024:.1f} KB · {plural(len(parts[cid]), 'excerpt')}, {ctx_bytes / 1024:.1f} KB)"
    )
    print(f"  {dim('workdir')}  {dim(str(work_dir))} (empty scratch)")
    print()

    raw_events_path = out / "_returns" / f"{cid}.events.jsonl"
    raw_return_path = out / "_returns" / f"{cid}.md"
    usage_path = out / "_returns" / f"{cid}.usage.json"
    start_time = time.time()
    exit_code = 0

    try:
        if args.replay_events:
            replay_path = args.replay_events.resolve()
            if not replay_path.is_file():
                fail(f"--replay-events file not found: {replay_path}")
            with replay_path.open("r", encoding="utf-8") as f:
                stream_info = process_acp_event_stream(
                    f,
                    cid=cid,
                    args=args,
                    wanted=wanted,
                    out=out,
                    raw_events_path=raw_events_path,
                    raw_return_path=raw_return_path,
                    usage_path=usage_path,
                    start_time=start_time,
                )
        else:
            acpx_cmd = [
                "acpx",
                "--agent",
                args.agent,
                "--cwd",
                str(work_dir),
                "--model",
                args.model,
                "--deny-all",
                "--no-fs",
                "--no-terminal",
                "--prompt-retries",
                "0",
                "--timeout",
                str(args.timeout),
                "--format",
                "json",
                "exec",
                "--config-option",
                f"thought_level={args.thought_level}",
                "--file",
                str(packet_path),
            ]
            proc = subprocess.Popen(
                acpx_cmd,
                cwd=str(work_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            stream_info = process_acp_event_stream(
                proc.stdout,
                cid=cid,
                args=args,
                wanted=wanted,
                out=out,
                raw_events_path=raw_events_path,
                raw_return_path=raw_return_path,
                usage_path=usage_path,
                start_time=start_time,
            )
            exit_code = proc.wait()
    finally:
        shutil.rmtree(scratch_root, ignore_errors=True)

    total_seconds = time.time() - start_time
    raw_return = stream_info["raw_return"]
    raw_return_path.parent.mkdir(parents=True, exist_ok=True)
    raw_return_path.write_text(raw_return, encoding="utf-8")

    eff_cfg = stream_info["effective_config"]
    eff_model = eff_cfg.get("model")
    eff_thought = eff_cfg.get("thought_level")
    tool_calls = stream_info["tool_calls"]
    first_code_at = stream_info["first_code_at"]
    stop_reason = stream_info["stop_reason"]
    rpc_errors = stream_info["rpc_errors"]
    quota_pct = stream_info["quota_pct"]
    usage = stream_info["usage"]

    reasons = []
    if exit_code != 0:
        reasons.append(f"acpx exited with code {exit_code}")
    if rpc_errors:
        reasons.append(f"ACP error: {'; '.join(rpc_errors)}")
    if len(tool_calls) > 0:
        names = ", ".join(tc.get("name", "tool") for tc in tool_calls)
        reasons.append(f"trace contained {len(tool_calls)} forbidden tool call(s): {names}")
    if eff_model != args.model:
        reasons.append(f"effective ACP model {eff_model!r} != requested {args.model!r}")
    if eff_thought != args.thought_level:
        reasons.append(f"effective ACP thought_level {eff_thought!r} != requested {args.thought_level!r}")
    if stop_reason and stop_reason != "end_turn":
        reasons.append(f"unexpected stopReason {stop_reason!r}")

    files = split_files(raw_return)
    missing = [f for f in wanted if f not in files or not files[f].strip()]
    if missing:
        reasons.append(f"missing expected file block(s) {missing}")

    staged_paths = []
    returned_bytes = 0
    returned_lines = 0
    ok = len(reasons) == 0

    for rel, repo_name in wanted.items():
        target = out / repo_name / rel
        if ok and rel in files:
            target.parent.mkdir(parents=True, exist_ok=True)
            body = files[rel] + "\n"
            target.write_text(body, encoding="utf-8")
            staged_paths.append(target)
            returned_bytes += len(body.encode("utf-8"))
            returned_lines += body.count("\n")
        elif not ok and target.exists():
            target.unlink()

    meta_record = {
        "slice": cid,
        "ok": ok,
        "error": "; ".join(reasons) if reasons else None,
        "requested": {"model": args.model, "thought_level": args.thought_level, "agent": args.agent},
        "effective": {
            "model": eff_model,
            "thought_level": eff_thought,
            "legacyCurrentModelId": stream_info["legacy_current_model"],
            "tier": stream_info["tier_name"],
        },
        "timeToFirstCodeSeconds": round(first_code_at, 2) if first_code_at is not None else None,
        "totalSeconds": round(total_seconds, 2),
        "toolCallCount": len(tool_calls),
        "toolCalls": tool_calls,
        "returnedBytes": returned_bytes,
        "returnedLines": returned_lines,
        "quotaPercentage": quota_pct,
        "stopReason": stop_reason,
        "usage": usage,
        "stagedFiles": [str(p) for p in staged_paths],
        "rawEventsPath": str(raw_events_path),
        "rawReturnPath": str(raw_return_path),
    }
    usage_path.write_text(json.dumps(meta_record, indent=2), encoding="utf-8")

    first_code_str = f"{first_code_at:.1f}s" if first_code_at is not None else "n/a"
    print(dim("─" * 72))
    if ok:
        print(
            f"  {paint('PASS', 'bold', 'green')}  {paint(cid, 'bold')} · "
            f"{paint(f'{eff_model} (thought_level={eff_thought})', 'cyan')}"
        )
        print(
            f"  first code: {paint(first_code_str, 'bold')} · "
            f"total: {paint(f'{total_seconds:.1f}s', 'bold')} · "
            f"tool calls: {paint('0', 'bold', 'green')} · "
            f"size: {paint(f'{returned_bytes:,} bytes ({returned_lines} lines)', 'bold')} · "
            f"quota: {dim(quota_pct)}"
        )
        for p in staged_paths:
            print(f"  staged: {dim(str(p))}")
        print(f"  events: {dim(str(raw_events_path))}")
        return 0
    else:
        err_summary = "; ".join(reasons)
        print(
            f"  {paint('FAIL', 'bold', 'red')}  {paint(cid, 'bold')} · "
            f"{paint(err_summary, 'red')}"
        )
        print(
            f"  first code: {first_code_str} · "
            f"total: {total_seconds:.1f}s · "
            f"tool calls: {paint(str(len(tool_calls)), 'bold', 'red' if tool_calls else 'green')} · "
            f"size: {returned_bytes:,} bytes · "
            f"quota: {dim(quota_pct)}"
        )
        print(f"  events: {dim(str(raw_events_path))}")
        print(f"  raw:    {dim(str(raw_return_path))}")
        return 1


COMMANDS = {"acp": cmd_acp, "send": cmd_send, "show": cmd_show, "runs": cmd_runs, "status": cmd_status, "ledger": cmd_ledger}


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
