```rust
use std::io::{self, ErrorKind};
use std::process::{Command, ExitStatus, Stdio};

use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::DefaultTerminal;

#[derive(Debug, Clone, PartialEq)]
pub enum ExternalAction {
    Traces { trace_id: String },
    Edit { path: String },
}

pub fn editor_argv(visual: Option<&str>, editor: Option<&str>) -> Vec<String> {
    if let Some(v) = visual {
        let parts: Vec<String> = v.split_whitespace().map(String::from).collect();
        if !parts.is_empty() {
            return parts;
        }
    }
    if let Some(e) = editor {
        let parts: Vec<String> = e.split_whitespace().map(String::from).collect();
        if !parts.is_empty() {
            return parts;
        }
    }
    vec!["vi".to_string()]
}

pub fn build_command(
    action: &ExternalAction,
    visual: Option<&str>,
    editor: Option<&str>,
) -> Command {
    match action {
        ExternalAction::Traces { trace_id } => {
            let mut cmd = Command::new("traces");
            cmd.arg(trace_id);
            cmd
        }
        ExternalAction::Edit { path } => {
            let argv = editor_argv(visual, editor);
            let (prog, args) = argv
                .split_first()
                .map(|(first, rest)| (first.as_str(), rest))
                .unwrap_or(("vi", &[]));
            let mut cmd = Command::new(prog);
            cmd.args(args);
            cmd.arg(path);
            cmd
        }
    }
}

pub fn program_name(
    action: &ExternalAction,
    visual: Option<&str>,
    editor: Option<&str>,
) -> String {
    match action {
        ExternalAction::Traces { .. } => "traces".to_string(),
        ExternalAction::Edit { .. } => editor_argv(visual, editor)
            .into_iter()
            .next()
            .unwrap_or_else(|| "vi".to_string()),
    }
}

/// Suspends the TUI terminal state, runs `command` with inherited stdio, and
/// restores the terminal state afterwards.
///
/// Manual verification: inside `piw`, press `o` on a node with a trace ID to open
/// `traces <trace-id>` or `e` to edit the workflow source in `$VISUAL`/`$EDITOR`,
/// interact with the child program, exit it, and verify the TUI redraws cleanly
/// with keyboard and mouse input still working.
pub fn run_external(
    terminal: &mut DefaultTerminal,
    command: &mut Command,
) -> io::Result<ExitStatus> {
    let mut stdout = io::stdout();
    execute!(stdout, DisableMouseCapture, LeaveAlternateScreen)?;
    if let Err(err) = disable_raw_mode() {
        let _ = execute!(stdout, EnterAlternateScreen, EnableMouseCapture);
        let _ = terminal.clear();
        return Err(err);
    }

    let child_result = command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();

    let resume_raw = enable_raw_mode();
    let resume_screen = execute!(stdout, EnterAlternateScreen, EnableMouseCapture);
    let resume_clear = terminal.clear();

    let status = child_result?;
    resume_raw?;
    resume_screen?;
    resume_clear?;

    Ok(status)
}

pub fn failure_notice(error: &io::Error, program: &str) -> String {
    if error.kind() == ErrorKind::NotFound {
        format!("{program} is not on PATH")
    } else {
        format!("{program} failed: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn editor_argv_prefers_visual_over_editor_and_fallback() {
        assert_eq!(
            editor_argv(Some("nvim"), Some("nano")),
            vec!["nvim".to_string()]
        );
        assert_eq!(editor_argv(None, Some("nano")), vec!["nano".to_string()]);
        assert_eq!(editor_argv(None, None), vec!["vi".to_string()]);
    }

    #[test]
    fn editor_argv_skips_empty_and_blank_values() {
        assert_eq!(
            editor_argv(Some(""), Some("hx")),
            vec!["hx".to_string()]
        );
        assert_eq!(
            editor_argv(Some("   \t\n "), Some("emacs")),
            vec!["emacs".to_string()]
        );
        assert_eq!(
            editor_argv(Some("   "), Some("")),
            vec!["vi".to_string()]
        );
        assert_eq!(editor_argv(None, Some("  \t  ")), vec!["vi".to_string()]);
    }

    #[test]
    fn editor_argv_splits_whitespace_arguments() {
        assert_eq!(
            editor_argv(Some("code -w --reuse-window"), Some("vim")),
            vec![
                "code".to_string(),
                "-w".to_string(),
                "--reuse-window".to_string()
            ]
        );
        assert_eq!(
            editor_argv(None, Some("  subl   -w  ")),
            vec!["subl".to_string(), "-w".to_string()]
        );
    }

    #[test]
    fn build_command_for_traces() {
        let action = ExternalAction::Traces {
            trace_id: "pi:9b1c2db1f2b9595e22b795d0".to_string(),
        };
        let cmd = build_command(&action, Some("code -w"), Some("vim"));
        assert_eq!(cmd.get_program(), OsStr::new("traces"));
        let args: Vec<&OsStr> = cmd.get_args().collect();
        assert_eq!(args, vec![OsStr::new("pi:9b1c2db1f2b9595e22b795d0")]);
        assert_eq!(
            program_name(&action, Some("code -w"), Some("vim")),
            "traces"
        );
    }

    #[test]
    fn build_command_for_edit_with_flags() {
        let action = ExternalAction::Edit {
            path: "/tmp/workflow.ts".to_string(),
        };
        let cmd = build_command(&action, Some("code -w"), Some("vim"));
        assert_eq!(cmd.get_program(), OsStr::new("code"));
        let args: Vec<&OsStr> = cmd.get_args().collect();
        assert_eq!(
            args,
            vec![OsStr::new("-w"), OsStr::new("/tmp/workflow.ts")]
        );
        assert_eq!(program_name(&action, Some("code -w"), Some("vim")), "code");
    }

    #[test]
    fn build_command_for_edit_default_fallback() {
        let action = ExternalAction::Edit {
            path: "workflow.ts".to_string(),
        };
        let cmd = build_command(&action, None, None);
        assert_eq!(cmd.get_program(), OsStr::new("vi"));
        let args: Vec<&OsStr> = cmd.get_args().collect();
        assert_eq!(args, vec![OsStr::new("workflow.ts")]);
        assert_eq!(program_name(&action, None, None), "vi");
    }

    #[test]
    fn failure_notice_formats_not_found_and_other_errors() {
        let not_found = io::Error::new(ErrorKind::NotFound, "no such file");
        assert_eq!(
            failure_notice(&not_found, "traces"),
            "traces is not on PATH"
        );

        let perm_denied = io::Error::new(ErrorKind::PermissionDenied, "access denied");
        assert_eq!(
            failure_notice(&perm_denied, "code"),
            "code failed: access denied"
        );
    }
}
```