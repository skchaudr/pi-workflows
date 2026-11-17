use super::RunSummary;
use crate::theme::Palette;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunFilter {
    pub text: String,
    pub active_only: bool,
    pub editing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterOutcome {
    Edited,
    Kept,
    Cleared,
    Ignored,
}

impl RunFilter {
    pub fn new() -> Self {
        Self {
            text: String::new(),
            active_only: false,
            editing: false,
        }
    }

    pub fn is_filtering(&self) -> bool {
        !self.text.trim().is_empty() || self.active_only
    }

    pub fn open(&mut self) {
        self.editing = true;
    }

    pub fn toggle_active(&mut self) {
        self.active_only = !self.active_only;
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> FilterOutcome {
        if !self.editing {
            return FilterOutcome::Ignored;
        }
        match key.code {
            KeyCode::Enter => {
                self.editing = false;
                FilterOutcome::Kept
            }
            KeyCode::Esc => {
                self.text.clear();
                self.editing = false;
                FilterOutcome::Cleared
            }
            KeyCode::Backspace => {
                if self.text.pop().is_some() {
                    FilterOutcome::Edited
                } else {
                    self.editing = false;
                    FilterOutcome::Cleared
                }
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.text.clear();
                FilterOutcome::Edited
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.text.push(c);
                FilterOutcome::Edited
            }
            _ => FilterOutcome::Ignored,
        }
    }

    pub fn title(&self, shown: usize, total: usize) -> String {
        if !self.is_filtering() {
            return format!(" Runs ({total}) ↔ ");
        }
        let mut s = format!(" Runs {shown}/{total}");
        let trimmed = self.text.trim();
        if !trimmed.is_empty() {
            s.push_str(" · /");
            s.push_str(trimmed);
        }
        if self.active_only {
            s.push_str(" · active");
        }
        s.push_str(" ↔ ");
        s
    }
}

pub fn visible<'a>(summaries: &'a [RunSummary], filter: &RunFilter) -> Vec<&'a RunSummary> {
    let terms: Vec<String> = filter
        .text
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .collect();

    if terms.is_empty() && !filter.active_only {
        return summaries.iter().collect();
    }

    summaries
        .iter()
        .filter(|run| {
            if filter.active_only && run.display.status.is_terminal() {
                return false;
            }
            if terms.is_empty() {
                return true;
            }
            let id_lower = run.run_id.to_lowercase();
            let wf_lower = run.workflow_name.to_lowercase();
            let title_lower = run.run_title.as_deref().map(str::to_lowercase);
            let status_lower = run.display.status.label().to_lowercase();

            terms.iter().all(|term| {
                id_lower.contains(term)
                    || wf_lower.contains(term)
                    || title_lower.as_ref().is_some_and(|t| t.contains(term))
                    || status_lower.contains(term)
            })
        })
        .collect()
}

pub fn reconcile_selection(visible: &[&RunSummary], selected: Option<&str>) -> Option<String> {
    if let Some(sel) = selected {
        if visible.iter().any(|run| run.run_id == sel) {
            return Some(sel.to_string());
        }
    }
    visible.first().map(|run| run.run_id.clone())
}

pub fn render_input(frame: &mut Frame, area: Rect, filter: &RunFilter, palette: &Palette) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let text_style = Style::default().fg(palette.text).bg(palette.panel_bg);
    let mut spans = vec![Span::styled("/ ", Style::default().fg(palette.accent))];

    if filter.text.is_empty() && filter.editing {
        spans.push(Span::styled("▏", Style::default().fg(palette.accent)));
        spans.push(Span::styled(
            "type to filter, space = AND",
            Style::default().fg(palette.muted),
        ));
    } else {
        spans.push(Span::styled(filter.text.as_str(), text_style));
        if filter.editing {
            spans.push(Span::styled("▏", Style::default().fg(palette.accent)));
        }
    }

    let line_area = Rect::new(area.x, area.y, area.width, 1);
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(text_style),
        line_area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::types::{RunStatus, WorkflowDisplay};

    fn make_run(
        run_id: &str,
        workflow_name: &str,
        run_title: Option<&str>,
        status: RunStatus,
    ) -> RunSummary {
        RunSummary {
            run_id: run_id.to_string(),
            workflow_name: workflow_name.to_string(),
            run_title: run_title.map(ToString::to_string),
            display: WorkflowDisplay {
                status,
                activity: None,
                controls: Vec::new(),
                reason: None,
                reason_content: None,
            },
            started_at: "2026-01-01T00:00:00Z".to_string(),
            finished_at: None,
            live: !status.is_terminal(),
            possibly_interrupted: false,
        }
    }

    fn ids(runs: &[&RunSummary]) -> Vec<String> {
        runs.iter().map(|r| r.run_id.clone()).collect()
    }

    #[test]
    fn visible_matches_and_terms_case_insensitively_across_fields() {
        let summaries = vec![
            make_run(
                "run-101",
                "deploy-service",
                Some("Landing Page Rollout"),
                RunStatus::Paused,
            ),
            make_run(
                "run-102",
                "deploy-service",
                Some("Landing Page Rollout"),
                RunStatus::Running,
            ),
            make_run("run-103", "billing-sync", None, RunStatus::Paused),
            make_run(
                "run-104",
                "cleanup",
                Some("Nightly job"),
                RunStatus::Completed,
            ),
        ];

        let mut filter = RunFilter::new();
        assert_eq!(
            ids(&visible(&summaries, &filter)),
            vec!["run-101", "run-102", "run-103", "run-104"]
        );

        // AND of terms across title ("LANDING") and status label ("paused"), case-insensitive
        filter.text = "LANDING paused".to_string();
        assert_eq!(ids(&visible(&summaries, &filter)), vec!["run-101"]);

        // Status label match with run_title = None
        filter.text = "billing paused".to_string();
        assert_eq!(ids(&visible(&summaries, &filter)), vec!["run-103"]);

        // Match by run_id
        filter.text = "104".to_string();
        assert_eq!(ids(&visible(&summaries, &filter)), vec!["run-104"]);
    }

    #[test]
    fn visible_respects_active_only_and_preserves_order() {
        let summaries = vec![
            make_run("r1", "wf", None, RunStatus::Completed),
            make_run("r2", "wf", None, RunStatus::Running),
            make_run("r3", "wf", None, RunStatus::Failed),
            make_run("r4", "wf", None, RunStatus::Paused),
            make_run("r5", "wf", None, RunStatus::TimedOut),
            make_run("r6", "wf", None, RunStatus::Cancelled),
            make_run("r7", "wf", None, RunStatus::Waiting),
        ];

        let mut filter = RunFilter::new();
        filter.toggle_active();
        assert!(filter.active_only);
        assert_eq!(ids(&visible(&summaries, &filter)), vec!["r2", "r4", "r7"]);
    }

    #[test]
    fn reconcile_selection_keeps_visible_or_falls_back_to_first_or_none() {
        let summaries = vec![
            make_run("r1", "alpha", None, RunStatus::Running),
            make_run("r2", "beta", None, RunStatus::Running),
        ];
        let mut filter = RunFilter::new();
        let all = visible(&summaries, &filter);

        assert_eq!(
            reconcile_selection(&all, Some("r2")),
            Some("r2".to_string())
        );
        assert_eq!(
            reconcile_selection(&all, Some("r999")),
            Some("r1".to_string())
        );
        assert_eq!(reconcile_selection(&all, None), Some("r1".to_string()));

        filter.text = "nonexistent".to_string();
        let none_vis = visible(&summaries, &filter);
        assert_eq!(reconcile_selection(&none_vis, Some("r1")), None);
    }

    #[test]
    fn handle_key_produces_each_filter_outcome() {
        let mut filter = RunFilter::new();
        // Ignored when not editing
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE)),
            FilterOutcome::Ignored
        );

        filter.open();
        assert!(filter.editing);

        // Backspace on empty closes and clears
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)),
            FilterOutcome::Cleared
        );
        assert!(!filter.editing);

        // Typing characters and backspace on non-empty
        filter.open();
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE)),
            FilterOutcome::Edited
        );
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE)),
            FilterOutcome::Edited
        );
        assert_eq!(filter.text, "ab");
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)),
            FilterOutcome::Edited
        );
        assert_eq!(filter.text, "a");

        // Unhandled key while editing is Ignored
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
            FilterOutcome::Ignored
        );

        // Enter keeps text and stops editing
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            FilterOutcome::Kept
        );
        assert!(!filter.editing);
        assert_eq!(filter.text, "a");

        // Ctrl-U clears text but keeps editing
        filter.open();
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)),
            FilterOutcome::Edited
        );
        assert!(filter.editing);
        assert_eq!(filter.text, "");

        // Esc clears text and stops editing
        filter.text = "abc".to_string();
        assert_eq!(
            filter.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            FilterOutcome::Cleared
        );
        assert!(!filter.editing);
        assert_eq!(filter.text, "");
    }

    #[test]
    fn title_formats_default_and_filtered_states() {
        let mut filter = RunFilter::new();
        assert!(!filter.is_filtering());
        assert_eq!(filter.title(41, 41), " Runs (41) ↔ ");

        filter.text = "landing paused".to_string();
        assert!(filter.is_filtering());
        assert_eq!(filter.title(3, 41), " Runs 3/41 · /landing paused ↔ ");

        filter.toggle_active();
        assert_eq!(
            filter.title(3, 41),
            " Runs 3/41 · /landing paused · active ↔ "
        );

        filter.text.clear();
        assert!(filter.is_filtering());
        assert_eq!(filter.title(10, 41), " Runs 10/41 · active ↔ ");
    }
}
