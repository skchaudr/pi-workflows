use crate::format::sanitize_text;
use crate::theme::Palette;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOp {
    Pause,
    Resume,
    Cancel,
}

impl RunOp {
    pub fn operation(self) -> &'static str {
        match self {
            RunOp::Pause => "run.pause",
            RunOp::Resume => "run.resume",
            RunOp::Cancel => "run.cancel",
        }
    }

    pub fn busy(self) -> &'static str {
        match self {
            RunOp::Pause => "pausing…",
            RunOp::Resume => "resuming…",
            RunOp::Cancel => "cancelling…",
        }
    }

    pub fn done(self) -> &'static str {
        match self {
            RunOp::Pause => "paused",
            RunOp::Resume => "resumed",
            RunOp::Cancel => "cancelled",
        }
    }

    fn verb(self) -> &'static str {
        match self {
            RunOp::Pause => "pause",
            RunOp::Resume => "resume",
            RunOp::Cancel => "cancel",
        }
    }
}

pub fn toggle_op(controls: &[String]) -> Option<RunOp> {
    if controls.iter().any(|c| c == "resume") {
        Some(RunOp::Resume)
    } else if controls.iter().any(|c| c == "pause") {
        Some(RunOp::Pause)
    } else {
        None
    }
}

pub fn no_control_notice(status: &str, controls: &[String]) -> String {
    let clean_status = sanitize_text(status);
    let status_label = if clean_status.is_empty() {
        "in its current state".to_string()
    } else {
        clean_status
    };
    if controls.iter().any(|c| c == "answer") {
        format!(
            "cannot pause or resume ({status_label}); checkpoint must be answered inside the owning Pi session, not from piw"
        )
    } else {
        format!("cannot pause or resume ({status_label})")
    }
}

pub fn outcome_notice(op: RunOp, outcome: &str, error: Option<&str>) -> String {
    let clean_outcome = sanitize_text(outcome);
    if clean_outcome == "accepted" || clean_outcome == "adopted" {
        return op.done().to_string();
    }
    let verb = op.verb();
    let outcome_label = if clean_outcome.is_empty() {
        "failed".to_string()
    } else {
        clean_outcome
    };
    match error.map(sanitize_text) {
        Some(err) if !err.is_empty() => format!("{verb} {outcome_label}: {err}"),
        _ => format!("{verb} {outcome_label}"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelConfirm {
    pub run_id: String,
    pub workflow: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmOutcome {
    Send,
    Dismissed,
}

impl CancelConfirm {
    pub fn begin(controls: &[String], run_id: &str, workflow: &str) -> Option<CancelConfirm> {
        if !controls.iter().any(|c| c == "cancel") {
            return None;
        }
        Some(CancelConfirm {
            run_id: sanitize_text(run_id),
            workflow: sanitize_text(workflow),
        })
    }

    pub fn handle_key(&self, key: KeyEvent) -> ConfirmOutcome {
        let disallowed = key.modifiers.difference(KeyModifiers::SHIFT);
        if disallowed.is_empty() && matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y')) {
            ConfirmOutcome::Send
        } else {
            ConfirmOutcome::Dismissed
        }
    }

    pub fn prompt(&self) -> String {
        let workflow = sanitize_text(&self.workflow);
        let run_id = sanitize_text(&self.run_id);
        match (workflow.is_empty(), run_id.is_empty()) {
            (false, false) => format!("cancel {workflow} {run_id}? y/N"),
            (false, true) => format!("cancel {workflow}? y/N"),
            (true, false) => format!("cancel {run_id}? y/N"),
            (true, true) => "cancel run? y/N".to_string(),
        }
    }
}

pub fn render_confirm(
    frame: &mut Frame,
    area: Rect,
    confirm: &CancelConfirm,
    palette: &Palette,
) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let line_area = Rect::new(area.x, area.y, area.width, 1);
    let line = Line::from(Span::styled(
        confirm.prompt(),
        Style::default().fg(palette.warning).bg(palette.panel_bg),
    ));
    frame.render_widget(
        Paragraph::new(line).style(Style::default().fg(palette.warning).bg(palette.panel_bg)),
        line_area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vec_str(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn run_op_labels_and_operations() {
        assert_eq!(RunOp::Pause.operation(), "run.pause");
        assert_eq!(RunOp::Resume.operation(), "run.resume");
        assert_eq!(RunOp::Cancel.operation(), "run.cancel");

        assert_eq!(RunOp::Pause.busy(), "pausing…");
        assert_eq!(RunOp::Resume.busy(), "resuming…");
        assert_eq!(RunOp::Cancel.busy(), "cancelling…");

        assert_eq!(RunOp::Pause.done(), "paused");
        assert_eq!(RunOp::Resume.done(), "resumed");
        assert_eq!(RunOp::Cancel.done(), "cancelled");
    }

    #[test]
    fn toggle_op_for_each_server_controls_configuration() {
        // running or waiting
        assert_eq!(
            toggle_op(&vec_str(&["pause", "cancel"])),
            Some(RunOp::Pause)
        );
        // pending checkpoint
        assert_eq!(
            toggle_op(&vec_str(&["pause", "cancel", "answer"])),
            Some(RunOp::Pause)
        );
        // pending decision
        assert_eq!(
            toggle_op(&vec_str(&["pause", "cancel", "human-answer"])),
            Some(RunOp::Pause)
        );
        // pending agent request
        assert_eq!(
            toggle_op(&vec_str(&["pause", "cancel", "update", "submit"])),
            Some(RunOp::Pause)
        );
        // paused or parked queue entry
        assert_eq!(
            toggle_op(&vec_str(&["resume", "cancel"])),
            Some(RunOp::Resume)
        );
        // resume wins over pause if both appear
        assert_eq!(
            toggle_op(&vec_str(&["pause", "resume", "cancel"])),
            Some(RunOp::Resume)
        );
        // queued (unparked) or terminal with active origin turn
        assert_eq!(toggle_op(&vec_str(&["cancel"])), None);
        // completed / failed / timed_out
        assert_eq!(toggle_op(&vec_str(&[])), None);
        // ambiguous run or unknown future controls
        assert_eq!(toggle_op(&vec_str(&["review", "future-op"])), None);
    }

    #[test]
    fn cancel_confirm_requires_cancel_control() {
        assert_eq!(
            CancelConfirm::begin(&vec_str(&["pause", "cancel"]), "20261115T120000", "landing"),
            Some(CancelConfirm {
                run_id: "20261115T120000".to_string(),
                workflow: "landing".to_string(),
            })
        );
        assert_eq!(
            CancelConfirm::begin(&vec_str(&["cancel"]), "20261115T120000", "landing")
                .map(|c| c.prompt()),
            Some("cancel landing 20261115T120000? y/N".to_string())
        );
        assert_eq!(
            CancelConfirm::begin(&vec_str(&[]), "20261115T120000", "landing"),
            None
        );
        assert_eq!(
            CancelConfirm::begin(&vec_str(&["pause", "review"]), "20261115T120000", "landing"),
            None
        );
    }

    #[test]
    fn cancel_confirm_key_handling() {
        let confirm = CancelConfirm {
            run_id: "run-1".to_string(),
            workflow: "landing".to_string(),
        };

        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)),
            ConfirmOutcome::Send
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Char('Y'), KeyModifiers::NONE)),
            ConfirmOutcome::Send
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Char('Y'), KeyModifiers::SHIFT)),
            ConfirmOutcome::Send
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::SHIFT)),
            ConfirmOutcome::Send
        );

        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE)),
            ConfirmOutcome::Dismissed
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Char('N'), KeyModifiers::SHIFT)),
            ConfirmOutcome::Dismissed
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            ConfirmOutcome::Dismissed
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            ConfirmOutcome::Dismissed
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL)),
            ConfirmOutcome::Dismissed
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(
                KeyCode::Char('Y'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT
            )),
            ConfirmOutcome::Dismissed
        );
        assert_eq!(
            confirm.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::ALT)),
            ConfirmOutcome::Dismissed
        );
    }

    #[test]
    fn outcome_notices_for_every_server_outcome() {
        for op in [RunOp::Pause, RunOp::Resume, RunOp::Cancel] {
            assert_eq!(outcome_notice(op, "accepted", None), op.done());
            assert_eq!(
                outcome_notice(op, "accepted", Some("ignored")),
                op.done()
            );
            assert_eq!(outcome_notice(op, "adopted", None), op.done());
        }

        let error_outcomes = [
            "rejected",
            "conflict",
            "notFound",
            "claimLost",
            "unavailable",
        ];
        for outcome in error_outcomes {
            let msg = outcome_notice(RunOp::Pause, outcome, Some("stale revision"));
            assert_eq!(msg, format!("pause {outcome}: stale revision"));

            let resume_msg = outcome_notice(RunOp::Resume, outcome, Some("not parked"));
            assert_eq!(resume_msg, format!("resume {outcome}: not parked"));

            let cancel_msg = outcome_notice(RunOp::Cancel, outcome, None);
            assert_eq!(cancel_msg, format!("cancel {outcome}"));
        }
    }

    #[test]
    fn checkpoint_wording_appears_only_when_answer_is_in_controls() {
        let with_answer = no_control_notice("waiting", &vec_str(&["cancel", "answer"]));
        assert!(with_answer.contains("checkpoint"));
        assert!(with_answer.contains("Pi session"));

        let without_answer_ cases = [
            vec_str(&[]),
            vec_str(&["cancel"]),
            vec_str(&["cancel", "human-answer"]),
            vec_str(&["cancel", "update", "submit"]),
            vec_str(&["review"]),
        ];
        for controls in without_answer_cases {
            let notice = no_control_notice("completed", &controls);
            assert!(
                !notice.contains("checkpoint"),
                "unexpected checkpoint mention in: {notice}"
            );
            assert!(
                !notice.contains("Pi session"),
                "unexpected Pi session mention in: {notice}"
            );
            assert!(notice.contains("completed"));
        }
    }
}
