#!/usr/bin/env python3
"""
piw-tui.py: ten parallel slices that add a keyboard-first layer to the piw viewer (Rust, tui/src/ui/).

Pure text generation, no tools. Every slice owns ONE new file, gets only the context that file needs, and returns
the complete file. Nothing edits an existing file, so slices cannot conflict. The ~30 lines of wiring into
ui/mod.rs and client.rs are done by hand afterwards (each slice's prompt states the public surface that wiring calls).

  python3 task-scripts/piw-tui.py --dry-run              sizes + estimate, no API call
  python3 task-scripts/piw-tui.py --only run_filter      fire one slice first
  python3 task-scripts/piw-tui.py                        fire all ten

Files land in task-scripts/piw-tui_out/<output_file>; every raw return is kept in piw-tui_out/_returns/<id>.md.
Copy the .rs files into tui/src/ui/ yourself once reviewed.
"""

MODEL = "google/gemini-4-argon"  # OpenRouter id; cheaper: google/gemini-3.7-flash ($0.75/$3.75 per M). Override with --model
CTX = "task-scripts/ctx"
MAX_TOKENS = 32000  # per slice; a return cut off at this is marked failed, not written

# Types two slices must agree on. Defined once here and pasted into both prompts.
TRACE_RECORD = """
#[derive(Debug, Clone, PartialEq)]
pub struct TraceRecord {
    pub id: String,      // e.g. "pi:9b1c2db1f2b9595e22b795d0"; passed to `traces <id>`
    pub status: String,  // "active" | "idle" | ...; display only
    pub model: String,   // may be empty
    pub title: String,   // may be empty
    pub path: String,    // transcript path on disk
}
"""

RULES = """
Hard rules: Rust 2021, ratatui 0.30, crossterm 0.29, serde_json. No new crates, no `unsafe`, no `unwrap()` or
`expect()` on anything that comes from I/O, the server, or the user. The file must compile at its output path inside the
existing crate (use `crate::` paths; from a file in `tui/src/ui/` the type `RunSummary` is `super::RunSummary`; do not
redefine types the interfaces file lists; a `// ---- tui/src/a/b.rs` header there means its items live at `crate::a::b::`,
and `mod.rs` names the folder: `tui/src/theme/mod.rs` is `crate::theme::`). Derive `Debug, Clone, PartialEq` on every public enum and plain-data struct you define.
Put unit tests in a `#[cfg(test)] mod tests` at the bottom; they must not need a terminal, network, or files.
Return the complete file in ONE ```rust block and nothing else: no prose before or after.
"""

TASKS = [
    {
        "custom_id": "run_filter",
        "output_file": "tui/src/ui/run_filter.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt", "tui/src/ui/theme_picker.rs"],
        "prompt": """
Write `run_filter.rs`: search and active-only filtering for the Runs browser. `theme_picker.rs` shows the house style
for ratatui rendering; `interfaces.rs.txt` has the types. Keys (wired later): `/` opens the input, `a` toggles active-only.

Public surface (the wiring calls exactly this):
    pub struct RunFilter { pub text: String, pub active_only: bool, pub editing: bool }
    impl RunFilter {
        pub fn new() -> Self;                         // empty, not editing
        pub fn is_filtering(&self) -> bool;           // text non-empty or active_only
        pub fn open(&mut self);                       // editing = true
        pub fn toggle_active(&mut self);
        pub fn handle_key(&mut self, key: crossterm::event::KeyEvent) -> FilterOutcome;   // only while editing
        pub fn title(&self, shown: usize, total: usize) -> String;   // filtering: " Runs 3/41 · /landing paused · active ↔ "; not filtering: " Runs (41) ↔ " (the existing title; keep it exactly)
    }
    pub enum FilterOutcome { Edited, Kept, Cleared, Ignored }
    pub fn visible<'a>(summaries: &'a [super::RunSummary], filter: &RunFilter) -> Vec<&'a super::RunSummary>;
    pub fn reconcile_selection(visible: &[&super::RunSummary], selected: Option<&str>) -> Option<String>;
    pub fn render_input(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, filter: &RunFilter, palette: &crate::theme::Palette);

Behaviour:
- Typing appends, Backspace deletes; Backspace on empty text closes (Cleared). Enter keeps the filter and stops editing (Kept).
  Esc clears text and stops editing (Cleared). Ctrl-U clears the text but keeps editing. Anything else is Ignored.
- visible(): the query is split on whitespace; EVERY term must appear (case-insensitive substring) in at least one of
  run_id, workflow_name, run_title, or display.status.label(). With active_only, drop runs whose status.is_terminal().
  Order of the input is preserved. Empty query + not active_only returns everything.
- reconcile_selection(): keep `selected` if it is visible; else the first visible run's id; else None.
- render_input draws one line `/ <text>▏` (cursor block only while editing) using palette.text on palette.panel_bg;
  a muted placeholder `type to filter, space = AND` when empty and editing.
Tests: AND of terms, case-insensitivity, status-label match ("paused"), run_title None, active_only, order preserved,
reconcile when selected is filtered out and when nothing matches, each FilterOutcome, the title strings.
`RunSummary` derives nothing (no Debug, Clone or PartialEq): build test values field by field and compare run ids, never the structs.
""" + RULES,
    },
    {
        "custom_id": "run_command",
        "output_file": "tui/src/ui/run_command.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt", "tui/src/ui/theme_picker.rs"],
        "prompt": """
Write `run_command.rs`: the UI-side state for pausing, resuming and cancelling the selected run. Keys (wired later):
`p` pause/resume, `x` cancel. Sending the request is another module's job; yours decides WHAT to send and what to show.

Facts about the server (verified against the running server; you cannot look them up):
- `display.controls` (Vec<String>) is the list of actions the server currently allows for the run. The server builds it so:
  running or waiting -> ["pause","cancel"], plus "answer" (pending checkpoint), "human-answer" (pending decision) or
  "update","submit" (pending agent request); paused -> ["resume","cancel"]; queued -> ["cancel"], or ["resume","cancel"]
  when the queue entry is parked; completed/failed/timed_out -> [], or ["cancel"] while its origin turn is still active;
  "review" is appended for an ambiguous run. Other strings may appear in future: ignore them.
  Offer only pause/resume/cancel, only when listed, and read the list at key-press time.
- Operations: "run.pause", "run.resume", "run.cancel". Cancel is terminal and cannot be undone: never on one keypress.
- Outcomes returned by the server: accepted, adopted, rejected, conflict, notFound, claimLost, unavailable.
  accepted and adopted are success; every other outcome carries an error string to show.
- A checkpoint ("answer" in controls) can only be answered inside the Pi session that owns the run, not from piw.

Public surface:
    #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum RunOp { Pause, Resume, Cancel }
    impl RunOp { pub fn operation(self) -> &'static str;      // "run.pause" ...
                 pub fn busy(self) -> &'static str;           // "pausing…" "resuming…" "cancelling…"
                 pub fn done(self) -> &'static str; }         // "paused" "resumed" "cancelled"
    pub fn toggle_op(controls: &[String]) -> Option<RunOp>;    // "resume" wins over "pause"; None if neither listed
    pub fn no_control_notice(status: &str, controls: &[String]) -> String;   // why nothing happened; mentions the checkpoint rule when "answer" is listed
    pub fn outcome_notice(op: RunOp, outcome: &str, error: Option<&str>) -> String;   // "paused" | "pause rejected: <error>"
    pub struct CancelConfirm { pub run_id: String, pub workflow: String }
    impl CancelConfirm {
        pub fn begin(controls: &[String], run_id: &str, workflow: &str) -> Option<CancelConfirm>;   // None unless "cancel" listed
        pub fn handle_key(&self, key: crossterm::event::KeyEvent) -> ConfirmOutcome;
        pub fn prompt(&self) -> String;                       // "cancel landing 20261115T…? y/N"
    }
    pub enum ConfirmOutcome { Send, Dismissed }               // KeyCode::Char('y') or Char('Y') with no modifier other than SHIFT sends (terminals report 'Y' with SHIFT set); every other key dismisses
    pub fn render_confirm(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, confirm: &CancelConfirm, palette: &crate::theme::Palette);   // one line, palette.warning
Tests: toggle_op for each real controls value above, cancel needs "cancel", confirm accepts y, Y, and Y with SHIFT (also check 'n',
Enter, Esc, Ctrl-Y), notices for every outcome string, the checkpoint wording appears only with "answer".
""" + RULES,
    },
    {
        "custom_id": "client_commands",
        "output_file": "tui/src/client_commands.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt", "tui/src/protocol.rs"],
        "prompt": """
Write `client_commands.rs`: the pure protocol side of sending a state-changing command (pause/resume/cancel) over the
workflow client connection. It does no I/O: it builds requests, tracks them until answered, and classifies responses.
`protocol.rs` is attached in full: reuse `ClientRequest`, `ServerResponse` and `PROTOCOL_ID`; do not redefine them, and do
not write an encoder (`protocol::encode_request` exists; each transport adds its own line ending, and a frame must never
contain a line break).

How the existing client sends (verified in client.rs, which you cannot see):
- There is no outbound queue. Each pass of the connection loop calls one function that builds the requests still owed
  from shared state, then sends them. The hand wiring will keep one `CommandTracker` in that shared state and call
  `take_unsent` from that function. On every reconnect the wiring calls `connection_lost` first.
- The existing response handler turns every rejected/notFound/unavailable response into a global connection error. The
  wiring will call `owns(request_id)` first and hand owned responses to `complete` instead.
- Existing view requests use ids "piw-<pid>-<n>" with a counter that restarts on every connection, and
  `idempotency_key == request_id`. Yours must NOT follow that.

Server rules (verified in the server source):
- Every request needs a non-empty `idempotencyKey`.
- The server stores each command by (clientId, idempotencyKey) in its database, across piw restarts, and a requestId
  must be globally unique. A repeated key with the same payload returns the stored receipt without acting again; a
  repeated key or requestId with a different payload is a conflict. So ids must be unique across processes and
  restarts: pid plus a counter is NOT enough, because pids are reused.
- One user action = one fresh idempotency key. If the connection drops before the response, the retry reuses the same
  idempotency key with a NEW requestId.
- Commands use `run_id = Some(id)`, `expected_revision = None`, `payload = json!({})`, `client_id = "piw-<pid>"`,
  `message_type = "request"`, `schema = PROTOCOL_ID`.
- Outcomes: accepted, adopted, rejected, conflict, notFound, claimLost, unavailable. accepted/adopted = success.

Public surface:
    pub struct CommandIds { .. }
    impl CommandIds {
        pub fn new() -> Self;                      // nonce = "<pid>-<unix time in nanoseconds at creation>" (SystemTime; use 0 if the clock is before the epoch)
        pub fn with_nonce(nonce: &str) -> Self;    // for tests
        pub fn next(&mut self) -> String;          // "piwc-<nonce>-<n>", n = 1, 2, 3 ...
    }
    pub fn build_command(ids: &mut CommandIds, operation: &str, run_id: &str) -> ClientRequest;   // requestId and idempotencyKey are two different ids.next() values
    pub fn retry_command(ids: &mut CommandIds, original: &ClientRequest) -> ClientRequest;        // same key/operation/runId/payload/clientId, new requestId
    pub struct CommandOutcome { pub outcome: String, pub error: Option<String> }
    impl CommandOutcome { pub fn from_response(response: &ServerResponse) -> Self;  pub fn is_success(&self) -> bool; }
    pub struct CommandTracker { .. }
    impl CommandTracker {
        pub fn new() -> Self;
        pub fn track(&mut self, request: ClientRequest);       // remember until answered; not sent yet
        pub fn take_unsent(&mut self, ids: &mut CommandIds) -> Vec<ClientRequest>;
            // requests to send now, in track order, each returned once per connection. A request that was already sent
            // on an earlier connection comes back as retry_command(..), and the tracker then answers to the NEW requestId.
        pub fn connection_lost(&mut self);                     // every unanswered request becomes unsent again
        pub fn owns(&self, request_id: &str) -> bool;
        pub fn complete(&mut self, request_id: &str, outcome: CommandOutcome) -> Option<(ClientRequest, CommandOutcome)>;   // removes the tracked request and returns it with its outcome; None if unknown
        pub fn is_pending(&self, run_id: &str) -> bool;
    }
`ClientRequest` and `ServerResponse` derive only Debug and Clone (no PartialEq): do not derive PartialEq on a type that
holds one, and compare their fields in tests, never the structs.
Tests: build_command gives a requestId different from its key, and two calls share neither; two CommandIds with
different nonces never collide; retry keeps the key and changes the requestId; from_response for an accepted response
and for a rejected one with an error; tracker: take_unsent returns a request once and nothing on the second call; after
connection_lost it returns it again with the same key and a new requestId that `owns` and `complete` recognise, while
the old requestId is no longer owned; is_pending clears after complete.
""" + RULES,
    },
    {
        "custom_id": "trace_match",
        "output_file": "tui/src/trace_match.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt"],
        "prompt": """
Write `trace_match.rs`: find the agent traces that belong to a workflow run, using the `grok-traces` tool.

Facts (verified on the machine; you cannot look them up):
- `grok-traces list --json --limit 5000` prints one JSON object per line (JSON Lines), ~25 ms for 1400 sessions.
  A real line, trimmed to the fields that matter:
  {"id":"pi:9b1c2db1f2b9595e22b795d0","source":"pi","title":"block:01a1da95-7f29-712c-be9d-dfb48934c29a","model":"gemini-3.8-flash-high",
   "path":"/Users/sab-mini/.pi/agent/sessions/--Volumes-Mini-SSD-offload-repos-grok-build--/2026-11-14T15-04-33-126Z_01a1da96-b866-7737-8cc0-7880da63a060.jsonl",
   "cwd":"/Volumes/Mini-SSD/offload/repos/grok-build","status":"active","parent_id":null}
  Other fields exist and may be null or absent (`model` is null in about a third of records; treat `title` the same way). Lines are not guaranteed to be valid: skip bad ones.
- A run's session binding (a serde_json::Value the viewer already has) looks like:
  {"schema":"pi-workflows.session-binding.v1","runId":"2026…","boundAt":"…","cwd":"/Volumes/Mini-SSD/offload/repos/grok-build",
   "piSessionId":"01a1da96-b866-7737-8cc0-7880da63a060",
   "piSessionFile":"/Users/sab-mini/.pi/agent/sessions/--Volumes-Mini-SSD-offload-repos-grok-build--/2026-11-14T15-04-33-126Z_01a1da96-b866-7737-8cc0-7880da63a060.jsonl"}
- `piSessionId` is always present in a binding; `piSessionFile` is optional and may be missing.
- The run's own trace is the record whose `path` equals `piSessionFile`. Subagent sessions started by it live under a
  directory named after the session id, e.g. ".../rex-adapter/01a1da96-b866-7737-8cc0-7880da63a060/280c2339-1bda-4600-8fde-4cd8a6ed3883/session.jsonl";
  match those when the session id is a whole PATH COMPONENT. A session id that is merely a substring of a longer
  component or filename must NOT match, except the exact piSessionFile match above. One real run matched 5 records.
- `grok-traces` may not be installed; spawning it then fails with io::ErrorKind::NotFound.

Define exactly this type (another module consumes it, so do not change it):
""" + TRACE_RECORD + """
Public surface:
    pub fn session_from_binding(binding: &serde_json::Value) -> Option<(Option<String>, String)>;   // (piSessionFile, piSessionId); the id is required and non-empty; a missing, null or empty file is None
    pub fn parse_list(jsonl: &str) -> Vec<TraceRecord>;                                       // skips malformed lines; null model/title -> ""
    pub fn matches_for_session(records: Vec<TraceRecord>, session_file: Option<&str>, session_id: &str) -> Vec<TraceRecord>;   // exact path match first (when the file is known), then component matches in input order
    pub fn list_traces() -> Result<Vec<TraceRecord>, String>;                                 // runs `grok-traces list --json --limit 5000`; NotFound -> Err("grok-traces is not on PATH"); nonzero exit -> Err with stderr's first line
    pub fn traces_for_binding(binding: Option<&serde_json::Value>) -> Result<Vec<TraceRecord>, String>;   // None binding, or one without piSessionId -> Err("run has no bound Pi session")
Tests: parse_list with good, malformed, and null-field lines; exact match ordered first; subagent path matches; the
substring false-positive case (session id "01a1da96-b866" must not match a path component "01a1da96-b866-7737-…");
binding without piSessionFile (still matches by path component); binding without piSessionId (None); empty result.
""" + RULES,
    },
    {
        "custom_id": "external_launch",
        "output_file": "tui/src/ui/external_launch.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt"],
        "prompt": """
Write `external_launch.rs`: run another full-screen program from inside the piw TUI and come back cleanly. Used for the
traces modal (`o`) and for editing a run's workflow source (`e`).

Verified facts:
- The `traces <trace-id>` program (e.g. `traces pi:9b1c2db1f2b9595e22b795d0`) opens a full-screen modal and
  reads keys from the terminal (it accepts grok-traces ids like the one above). Started while the parent still owns the terminal (raw mode, alternate screen, mouse
  capture on) it EXITS IMMEDIATELY with status 0. It works only after the parent has fully released the terminal.
- piw sets up with `ratatui::init()` (raw mode + alternate screen + a panic hook) and
  `crossterm::execute!(stdout, EnableMouseCapture)`; it tears down with `DisableMouseCapture` then `ratatui::restore()`.
  Do NOT call `ratatui::init()` again to resume: every call stacks another panic hook. Suspend and resume with crossterm
  directly and keep the same terminal value.
- The event loop owns the terminal, so the launch is performed by the loop; key handling only records a request.

Public surface:
    #[derive(Debug, Clone, PartialEq)] pub enum ExternalAction { Traces { trace_id: String }, Edit { path: String } }
    pub fn editor_argv(visual: Option<&str>, editor: Option<&str>) -> Vec<String>;   // $VISUAL, else $EDITOR, else ["vi"]; empty/blank values skipped; split on whitespace so "code -w" works
    pub fn build_command(action: &ExternalAction, visual: Option<&str>, editor: Option<&str>) -> std::process::Command;   // Traces -> `traces <id>`; Edit -> editor argv + path
    pub fn program_name(action: &ExternalAction, visual: Option<&str>, editor: Option<&str>) -> String;   // for the "not on PATH" notice
    pub fn run_external(terminal: &mut ratatui::DefaultTerminal, command: &mut std::process::Command) -> std::io::Result<std::process::ExitStatus>;
        // suspend: execute!(stdout, DisableMouseCapture, LeaveAlternateScreen), then disable_raw_mode(); spawn with
        // inherited stdio and wait; resume: enable_raw_mode(), execute!(stdout, EnterAlternateScreen, EnableMouseCapture),
        // then terminal.clear(). Resume even when spawn or wait fails, and return the original error afterwards.
    pub fn failure_notice(error: &std::io::Error, program: &str) -> String;   // NotFound -> "<program> is not on PATH"; otherwise "<program> failed: <error>"
Tests: editor_argv precedence/blank/whitespace cases, build_command argv for both actions (inspect with
`command.get_program()`/`get_args()`), failure_notice for NotFound and another kind. run_external itself needs a
terminal and is not unit-tested; put a short comment on it saying how to check it by hand.
""" + RULES,
    },
    {
        "custom_id": "trace_picker",
        "output_file": "tui/src/ui/trace_picker.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt", "tui/src/ui/theme_picker.rs"],
        "prompt": """
Write `trace_picker.rs`: a small overlay that lists a run's several matching agent traces so the user can pick one with
the keyboard. Model it on `theme_picker.rs` (same popup, list, footer style). A run can match several traces (one real
run matched 5): the first is the run's own session, the rest are subagent sessions. Keys inside the overlay: Up/`k`,
Down/`j`, Enter picks, Esc closes.

The trace type lives in another module. Import it with `use crate::trace_match::TraceRecord;` and do NOT define a
struct of that name in your file. It is shown here only so you know its fields:
""" + TRACE_RECORD + """
Public surface:
    pub struct TracePicker { pub records: Vec<TraceRecord>, pub selected: usize }
    impl TracePicker {
        pub fn new(records: Vec<TraceRecord>) -> Self;
        pub fn move_previous(&mut self);   // clamps at 0
        pub fn move_next(&mut self);       // clamps at last
        pub fn handle_key(&mut self, key: crossterm::event::KeyEvent) -> PickerOutcome;
        pub fn selected_id(&self) -> Option<&str>;
    }
    pub enum PickerOutcome { Pick(String), Close, Continue }     // Pick carries the trace id
    pub fn row_text(record: &TraceRecord, width: usize) -> String;   // "▌ active  gemini-3.8-flash-high  block:01a1da95-…" truncated to width with "…"; empty model/title shown as "-"; width-safe for multi-byte text (use unicode-width)
    pub fn render(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, picker: &TracePicker, palette: &crate::theme::Palette);
        // popup via super::theme_picker::popup_rect, title " Traces (j/k, enter, esc) ", selected row uses palette.selection_bg
Tests: movement clamping, every key, row_text truncation including a wide-character title and width 0/1/2, empty
records (selected_id None, Enter -> Close).
""" + RULES,
    },
    {
        "custom_id": "help",
        "output_file": "tui/src/ui/help.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt", f"{CTX}/handle_key.rs.txt", f"{CTX}/interaction.md", f"{CTX}/footer.rs.txt", "tui/src/ui/theme_picker.rs"],
        "prompt": """
Write `help.rs`: a `?` overlay that lists every key binding, grouped, scrollable, and one const table that is the single
source of truth. Attached: `handle_key.rs.txt` (the real key handler), `interaction.md` (the documented keys), and
`footer.rs.txt` (today's footer hint line).

Content:
- Read the existing bindings from handle_key.rs.txt (it wins over the docs). It ends with `handle_theme_picker_key`,
  the keys that apply while the theme picker is open. If the docs and the code disagree on
  anything, list the disagreement as `// DISAGREEMENT: ...` comments at the top of the file.
- Add the NEW bindings (wired later by hand), exactly these:
    `/` filter runs (type to narrow; space = AND)      `a` toggle active-only runs
    `p` pause or resume the selected run               `x` cancel the selected run (asks y/N)
    `o` open the run's agent traces                    `e` edit the run's workflow source in $VISUAL/$EDITOR
    `y` copy the run id to the clipboard               `?` this help
- Groups, in this order: Replay, Focus, Graph, Runs, Inspector, Run control, Traces and source, Theme, General.

Public surface:
    pub struct Binding { pub group: &'static str, pub keys: &'static str, pub action: &'static str }
    pub const BINDINGS: &[Binding] = &[ .. ];
    pub struct HelpState { pub scroll: usize }
    impl HelpState {
        pub fn new() -> Self;
        pub fn handle_key(&mut self, key: crossterm::event::KeyEvent, visible_rows: usize, total_rows: usize) -> HelpOutcome;   // j/k/Up/Down/PageUp/PageDown scroll (clamped); `?`, Esc, `q` close
    }
    pub enum HelpOutcome { Continue, Close }
    pub fn lines(width: usize) -> Vec<String>;      // the table laid out as plain lines with group headings, wrapped/truncated to width
    pub fn render(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, state: &HelpState, palette: &crate::theme::Palette);
    pub const FOOTER_KEYS: &str = "f: follow  z: density  ,: theme  ?: help  q: quit";    // exactly this text
    pub const FOOTER_KEYS_EMPTY: &str = " ,: theme  Tab: focus  ?: help  q: quit";          // exactly this text
Footer: `footer.rs.txt` shows the two current hint lines. The normal one is built at run time as
`format!(" {}x  f: follow  z: density  ,: theme  q: quit", view.speed)`, so a const cannot hold all of it: FOOTER_KEYS is
the part after the speed. In a `// WIRING:` comment give, for each of the two hints, the exact old line and the exact
new line to paste.
Tests: no duplicate (group, keys) pair; every NEW key above is present in BINDINGS; every group in the order above has
at least one row; `lines()` never exceeds the width, even for width 20; scrolling clamps at both ends; `?`/Esc/q close.
""" + RULES,
    },
    {
        "custom_id": "notice",
        "output_file": "tui/src/ui/notice.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt", f"{CTX}/footer.rs.txt"],
        "prompt": """
Write `notice.rs`: a transient one-line message ("copied 2026…", "paused", "traces is not on PATH") that every feature
can raise and that fades by itself. It must work without owning the draw loop: the wiring stores one `Notice` on App
and calls `render` last, over the footer line. `footer.rs.txt` shows the footer it sits on.

Public surface:
    pub struct Notice { pub text: String, pub level: Level, pub raised: std::time::Instant }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Level { Info, Warn, Error }
    pub const TTL: std::time::Duration;                                   // 4 s, for Info and Warn
    pub const ERROR_TTL: std::time::Duration;                             // 8 s, for Error
    impl Notice {
        pub fn info(text: impl Into<String>) -> Self;  pub fn warn(text: impl Into<String>) -> Self;  pub fn error(text: impl Into<String>) -> Self;
        pub fn expired_at(&self, now: std::time::Instant) -> bool;        // pure, so tests need no sleeping
    }
    pub fn current(notice: &Option<Notice>, now: std::time::Instant) -> Option<&Notice>;   // None once expired
    pub fn render(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, notice: &Notice, palette: &crate::theme::Palette);
        // draws on the LAST row of `area`, left-aligned, text run through crate::format::sanitize_text, truncated with
        // "…" to the width (unicode-width), Info=palette.success, Warn=palette.warning, Error=palette.error, on palette.app_bg (the footer's background)
    pub fn truncate_to_width(text: &str, width: usize) -> String;        // width-safe for wide chars; width 0 -> ""
Tests: expiry boundaries for each level using constructed Instants (Instant::now() + offsets), `current` returns None
after expiry, truncate_to_width with ASCII, CJK, an emoji, and width 0/1.
""" + RULES,
    },
    {
        "custom_id": "clipboard",
        "output_file": "tui/src/ui/clipboard.rs",
        "context_files": [f"{CTX}/interfaces.rs.txt"],
        "prompt": """
Write `clipboard.rs`: copy text to the user's clipboard from inside a terminal program using the OSC 52 escape
sequence (needs no external tool; verified working in the user's terminal, Rex). Used by `y` to copy the selected run id.
`base64` 0.22 is already a dependency (use `base64::engine::general_purpose::STANDARD` and `Engine`).

Facts: the sequence is ESC ] 52 ; c ; <base64 of the text> BEL. No multiplexer handling. Cap the payload at 100_000 bytes of input text and refuse bigger input.

Public surface:
    pub fn osc52_sequence(text: &str) -> Result<String, String>;   // Err on empty or oversized text
    pub fn copy(text: &str) -> Result<(), String>;      // writes osc52_sequence(text) to stdout and flushes; map I/O errors to String
    pub fn copied_notice(text: &str) -> String;         // "copied 20261115T021043931Z-landing-9197de92"; long text shortened with "…" after 40 chars
Tests: exact sequence for a known string (compute the base64 of "hello" by hand: aGVsbG8=), empty and oversized rejection, the notice shortening, multi-byte text round-trips through base64 decode.
""" + RULES,
    },
    {
        "custom_id": "keyboard_audit",
        "output_file": "docs/piw-keyboard-audit.md",
        "raw": True,
        "context_files": [f"{CTX}/handle_mouse.rs.txt", f"{CTX}/handle_key.rs.txt", f"{CTX}/interaction.md"],
        "prompt": """
Write `docs/piw-keyboard-audit.md`: a keyboard-parity audit of the piw viewer. The goal is a viewer that can be driven
entirely from the keyboard. Attached: the real mouse handler, the real key handler, and the documented interaction list.

Do this from the attached code only. For EVERY action the mouse handler can perform, decide whether the key handler
already offers an equivalent. Output a markdown document with:
1. A table: | Action | Mouse (what the handler does) | Key today | Gap? |  one row per distinct mouse action (clicks on
   timeline track/buttons, graph node clicks, graph drag-pan, sidebar border drag-resize, inspector border drag-resize,
   inspector tab clicks, run-list clicks and scroll, theme-picker clicks, wheel scrolling, ...).
2. For each gap, a proposal: the key, why it is free, what it does. Keys already taken are in handle_key.rs.txt; also
   reserved for other work and NOT available: `/` `a` `p` `x` `o` `e` `y` `?`.
3. A short "needs a design decision" list for gaps where no obvious key exists (say why).
4. Any place where the docs in interaction.md disagree with the code in handle_key.rs.txt, quoted.
Be specific: quote the match arm or condition you based each row on. Do not invent handler behaviour that is not in the
code shown; if the excerpt is cut off, say "not shown" for that part. Return the markdown document itself, with no
surrounding code fence.
""",
    },
]

# ═══════════════════════════════════════════════════════════════════════
# Engine (from templates/parallel-slices-with-context.py; patched: max_tokens + truncation check,
# raw returns kept in _returns/, per-task "raw" output, --only, --dry-run). Nothing below needs editing.
# ═══════════════════════════════════════════════════════════════════════
import argparse, json, os, re, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
CHEAPER_ENDPOINT = "https://api.cheaperinference.com/v1/chat/completions"
OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
TIMEOUT, MAX_RETRIES, RETRY_DELAY = 600, 3, 2.0
MAX_CONTEXT_CHARS = 32 * 1024  # per context file; anything cut is warned about
PRICE_IN_PER_M, PRICE_OUT_PER_M = 2.00, 10.00  # google/gemini-4-argon on OpenRouter (checked 2026-11-16); estimate only, update with MODEL
TaskSpec = Dict[str, Any]

def make_http_request(url: str, headers: dict, data: dict = None, method: str = "GET") -> dict:
    """Zero-dependency HTTP JSON client with retry on transient errors."""
    body_bytes = json.dumps(data).encode("utf-8") if data is not None else None
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                resp_body = resp.read().decode("utf-8", errors="replace")
                try:
                    return json.loads(resp_body)
                except json.JSONDecodeError as e:
                    raise RuntimeError(f"Invalid JSON response: {resp_body[:200]}") from e
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            if e.code in (408, 429, 500, 502, 503, 504) and attempt < MAX_RETRIES - 1:
                delay = RETRY_DELAY * (attempt + 1)
                print(f"    [!] HTTP {e.code}, retrying in {delay:.0f}s...", file=sys.stderr)
                time.sleep(delay)
                continue
            raise RuntimeError(f"HTTP {e.code}: {err_body[:500]}")
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < MAX_RETRIES - 1:
                delay = RETRY_DELAY * (attempt + 1)
                print(f"    [!] Network error ({e}), retrying in {delay:.0f}s...", file=sys.stderr)
                time.sleep(delay)
                continue
            raise RuntimeError(f"Network error: {e}")
    raise RuntimeError("Request failed after all retries")

def extract_code_from_markdown(content: str) -> str:
    content = re.sub(r"^<think>[\s\S]*?</think>\s*", "", (content or "").replace("\r\n", "\n"))
    pattern = r"```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```"
    matches = re.findall(pattern, content, flags=re.IGNORECASE)
    if matches:
        return "\n\n".join(matches).strip()
    return content.strip()

def resolve_api_config(cli_key=None, cli_endpoint=None):
    key = cli_key or os.environ.get("CHEAPERINFERENCE_API_KEY") or os.environ.get("CHEAPER_INFERENCE_API_KEY")
    if not key and sys.platform == "darwin":
        for svc in ("cheaper-inference-skchadur-2-api-key", "cheaper-inference-api-key"):
            try:
                import subprocess
                out = subprocess.check_output(["security", "find-generic-password", "-s", svc, "-w"], stderr=subprocess.DEVNULL)
                key = out.decode().strip()
                if key: break
            except Exception: pass
    if key and not cli_endpoint:
        return key, CHEAPER_ENDPOINT
    key = key or os.environ.get("OPENROUTER_API_KEY")
    endpoint = cli_endpoint or (CHEAPER_ENDPOINT if key and key.startswith("ci_") else OPENROUTER_ENDPOINT)
    return key, endpoint

def build_prompt_with_context(repo_root: Path, task: TaskSpec) -> str:
    context_blocks = []
    repo_resolved = repo_root.resolve()
    for rel_path in task.get("context_files", []):
        file_path = (repo_root / rel_path).resolve()
        if not file_path.is_relative_to(repo_resolved):
            print(f"    [!] Security: Skipping out-of-repo path: {rel_path}", file=sys.stderr)
            continue
        if not file_path.is_file():
            print(f"    [!] Warning: Context file not found: {file_path}", file=sys.stderr)
            continue
        content = file_path.read_text(encoding="utf-8", errors="replace")
        if len(content) > MAX_CONTEXT_CHARS:
            print(f"    [!] {task['custom_id']}: {rel_path} is {len(content):,} chars, cut to {MAX_CONTEXT_CHARS:,}", file=sys.stderr)
            content = content[:MAX_CONTEXT_CHARS] + "\n... [truncated]"
        context_blocks.append(
            f"### Existing File Context: `{rel_path}`\n```\n{content}\n```"
        )

    context_str = "\n\n".join(context_blocks)
    if context_str:
        return (
            f"=== REPOSITORY CONTEXT ===\n\n"
            f"{context_str}\n\n"
            f"=== TASK SPECIFICATION ===\n\n"
            f"Target output file: `{task['output_file']}`\n\n"
            f"{task['prompt']}"
        )
    return f"Target output file: `{task['output_file']}`\n\n{task['prompt']}"

def execute_single_task(api_key: str, endpoint: str, model: str, task: TaskSpec, repo_root: Path, output_base: Path) -> Dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    full_prompt = build_prompt_with_context(repo_root, task)
    payload = {
        "model": model,
        "temperature": 0.0,
        "max_tokens": MAX_TOKENS,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a principal software engineer. Write production-ready code with complete types "
                    "and comprehensive tests where requested. Adhere strictly to the existing codebase conventions "
                    "provided in the context. Return code blocks only."
                ),
            },
            {
                "role": "user",
                "content": full_prompt,
            },
        ],
    }
    start = time.time()
    try:
        res = make_http_request(endpoint, headers=headers, data=payload, method="POST")
        choices = res.get("choices", [])
        if not choices:
            return {"task": task, "success": False, "error": "No response choices returned"}

        raw_content = choices[0].get("message", {}).get("content", "")
        returns = output_base / "_returns" / f"{task['custom_id']}.md"
        returns.parent.mkdir(parents=True, exist_ok=True)
        returns.write_text(raw_content or "", encoding="utf-8")
        finish = choices[0].get("finish_reason") or choices[0].get("native_finish_reason")
        if str(finish).lower() in ("length", "max_tokens"):
            return {"task": task, "success": False, "error": f"TRUNCATED at max_tokens={MAX_TOKENS}; partial return kept in {returns}"}
        clean_code = raw_content.strip() if task.get("raw") else extract_code_from_markdown(raw_content)

        target_path = output_base / task["output_file"]
        target_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = target_path.with_suffix(target_path.suffix + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(clean_code + "\n")
        tmp_path.replace(target_path)

        elapsed = time.time() - start
        return {"task": task, "success": True, "path": target_path, "elapsed": elapsed, "chars": len(clean_code)}
    except Exception as e:
        return {"task": task, "success": False, "error": str(e)}

def run_pipeline(api_key: str, endpoint: str, model: str, repo_root: Path, output_base: Path, tasks: List[TaskSpec]):
    print(f"\n[🚀] Launching parallel generation for {len(tasks)} tasks on {model} ({endpoint})...")
    print(f"    Repo root: {repo_root}")
    print(f"    Output base: {output_base}")
    start_total = time.time()
    results = []

    with ThreadPoolExecutor(max_workers=min(len(tasks), 16)) as executor:
        future_to_task = {
            executor.submit(execute_single_task, api_key, endpoint, model, t, repo_root, output_base): t
            for t in tasks
        }
        for future in as_completed(future_to_task):
            res = future.result()
            task = res["task"]
            if res["success"]:
                print(f"    [✓] Generated ({res['elapsed']:.1f}s): {res['path']} ({res['chars']} chars)")
            else:
                print(f"    [✗] Failed {task['custom_id']}: {res['error']}")
            results.append(res)

    total_time = time.time() - start_total
    success_count = sum(1 for r in results if r["success"])
    print(f"\n[🎉] Complete! {success_count}/{len(tasks)} files generated in {total_time:.1f}s!")

def main():
    parser = argparse.ArgumentParser(description="Parallel AI Code Generator with Context Injection")
    parser.add_argument("--key", default=None, help="API key (CHEAPERINFERENCE_API_KEY or OPENROUTER_API_KEY)")
    parser.add_argument("--endpoint", default=None, help="Completions endpoint")
    parser.add_argument("--model", default=MODEL, help=f"Model identifier (default: {MODEL})")
    parser.add_argument("--repo", default=str(HERE.parent), help="Repository root for context files (default: the repo holding this script)")
    parser.add_argument("--output", default=str(HERE / "piw-tui_out"), help="Base output directory")
    parser.add_argument("--only", help="Comma-separated slice ids to fire")
    parser.add_argument("--dry-run", action="store_true", help="Show prompt sizes and cost estimate, call nothing")
    args = parser.parse_args()

    key, endpoint = (None, None) if args.dry_run else resolve_api_config(args.key, args.endpoint)
    if not key and not args.dry_run:
        print("Error: API key required via --key, CHEAPERINFERENCE_API_KEY, or OPENROUTER_API_KEY.", file=sys.stderr)
        sys.exit(1)

    tasks = [t for t in TASKS if not args.only or t["custom_id"] in args.only.split(",")]
    if not tasks:
        sys.exit(f"--only matched nothing; ids: {', '.join(t['custom_id'] for t in TASKS)}")
    if args.dry_run:
        total_in = 0
        for t in tasks:
            n = len(build_prompt_with_context(Path(args.repo).resolve(), t))
            total_in += n
            print(f"    {t['custom_id']:<16} {n:>7,} chars in  -> {t['output_file']}")
        est = total_in / 4 * PRICE_IN_PER_M / 1e6 + len(tasks) * 6000 * PRICE_OUT_PER_M / 1e6
        print(f"\n[dry run] {len(tasks)} slice(s), ~{total_in // 4:,} tokens in, ~$ {est:.3f} at PRICE_* rates (assumes ~6k tokens out per slice). No API call made.")
        return
    run_pipeline(
        api_key=key,
        endpoint=endpoint,
        model=args.model,
        repo_root=Path(args.repo).resolve(),
        output_base=Path(args.output).resolve(),
        tasks=tasks,
    )

if __name__ == "__main__":
    main()
