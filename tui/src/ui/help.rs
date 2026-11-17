// DISAGREEMENT: Docs state "End to jump to latest, and ... Active runs also show Live; `G` and `L` are its keyboard shortcuts", distinguishing End from G/L. In handle_key, `KeyCode::End | KeyCode::Char('G') | KeyCode::Char('L')` all map identically to `app.rejoin_live()`.
// DISAGREEMENT: Docs omit Up/Down or `j`/`k` navigation inside the Inspector pane, whereas handle_key handles Up/`k` and Down/`j` across all four Inspector tabs (Steps: step back/forward; Trace: select trace entry; Conversation: select conversation entry; Info: scroll).
// DISAGREEMENT: Docs call the left pane "Browser", whereas handle_key refers to `Focus::Runs`.
// DISAGREEMENT: Docs mention mouse actions (clicking buttons, nodes, and dragging borders/graph), whereas handle_key only handles keyboard events.
//
// WIRING:
// 1. In `tui/src/ui/timeline.rs` (normal hint):
//    Old: `format!(" {}x  f: follow  z: density  ,: theme  q: quit", view.speed),`
//    New: `format!(" {}x  {}", view.speed, super::help::FOOTER_KEYS),`
// 2. In `tui/src/ui/timeline.rs` (empty-state hint):
//    Old: `" ,: theme  Tab: focus  q: quit",`
//    New: `super::help::FOOTER_KEYS_EMPTY,`

use crate::theme::Palette;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

pub const FOOTER_KEYS: &str = "f: follow  z: density  ,: theme  ?: help  q: quit";
pub const FOOTER_KEYS_EMPTY: &str = " ,: theme  Tab: focus  ?: help  q: quit";

pub const GROUP_ORDER: &[&str] = &[
    "Replay",
    "Focus",
    "Graph",
    "Runs",
    "Inspector",
    "Run control",
    "Traces and source",
    "Theme",
    "General",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub group: &'static str,
    pub keys: &'static str,
    pub action: &'static str,
}

pub const BINDINGS: &[Binding] = &[
    // Replay
    Binding {
        group: "Replay",
        keys: "[ / ]",
        action: "Step back / forward",
    },
    Binding {
        group: "Replay",
        keys: "Space",
        action: "Toggle playback (play / pause)",
    },
    Binding {
        group: "Replay",
        keys: "Home / g",
        action: "Move to start",
    },
    Binding {
        group: "Replay",
        keys: "End / G / L",
        action: "Jump to latest / rejoin live",
    },
    Binding {
        group: "Replay",
        keys: "{ / }",
        action: "Slower / faster playback",
    },
    // Focus
    Binding {
        group: "Focus",
        keys: "Tab",
        action: "Cycle focus (Runs -> Graph -> Inspector)",
    },
    Binding {
        group: "Focus",
        keys: "t",
        action: "Cycle inspector tab",
    },
    Binding {
        group: "Focus",
        keys: "1 / 2 / 3 / 4",
        action: "Select Steps / Trace / Conversation / Info tab",
    },
    // Graph
    Binding {
        group: "Graph",
        keys: "arrows or hjkl",
        action: "move to the nearest node that way",
    },
    Binding {
        group: "Graph",
        keys: "Shift+arrows",
        action: "pan the graph",
    },
    Binding {
        group: "Graph",
        keys: "n / N",
        action: "next / previous node",
    },
    Binding {
        group: "Graph",
        keys: "Enter",
        action: "show the selected node in the Inspector",
    },
    Binding {
        group: "Graph",
        keys: "0",
        action: "Reset pan and enable follow",
    },
    Binding {
        group: "Graph",
        keys: "f",
        action: "Toggle centered follow",
    },
    Binding {
        group: "Graph",
        keys: "z / + / -",
        action: "Toggle boxed / compact node density",
    },
    // Runs
    Binding {
        group: "Runs",
        keys: "b",
        action: "Expand or collapse runs sidebar",
    },
    Binding {
        group: "Runs",
        keys: "Up / Down / j / k",
        action: "Select previous / next run",
    },
    Binding {
        group: "Runs",
        keys: "/",
        action: "filter runs (type to narrow; space = AND)",
    },
    Binding {
        group: "Runs",
        keys: "a",
        action: "toggle active-only runs",
    },
    // Inspector
    Binding {
        group: "Inspector",
        keys: "Up / Down / j / k",
        action: "Select item or scroll (tab-dependent)",
    },
    Binding {
        group: "Inspector",
        keys: "Enter",
        action: "Expand / collapse selected step, trace, or entry",
    },
    Binding {
        group: "Inspector",
        keys: "v",
        action: "Cycle trace scope (Trace tab)",
    },
    Binding {
        group: "Inspector",
        keys: "< / >",
        action: "Previous / next page (Info tab)",
    },
    Binding {
        group: "Inspector",
        keys: "PageUp / PageDown",
        action: "Scroll inspector content",
    },
    // Run control
    Binding {
        group: "Run control",
        keys: "p",
        action: "pause or resume the selected run",
    },
    Binding {
        group: "Run control",
        keys: "x",
        action: "cancel the selected run (asks y/N)",
    },
    // Traces and source
    Binding {
        group: "Traces and source",
        keys: "o",
        action: "open the run's agent traces",
    },
    Binding {
        group: "Traces and source",
        keys: "e",
        action: "edit the run's workflow source in $VISUAL/$EDITOR",
    },
    Binding {
        group: "Traces and source",
        keys: "y",
        action: "copy the run id to the clipboard",
    },
    // Theme
    Binding {
        group: "Theme",
        keys: ",",
        action: "Open theme picker",
    },
    Binding {
        group: "Theme",
        keys: "Up / Down / j / k",
        action: "Preview previous / next theme (in picker)",
    },
    Binding {
        group: "Theme",
        keys: "Enter / Esc",
        action: "Apply / cancel theme selection (in picker)",
    },
    // General
    Binding {
        group: "General",
        keys: "?",
        action: "this help",
    },
    Binding {
        group: "General",
        keys: "q / Ctrl-C",
        action: "Quit",
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelpOutcome {
    Continue,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HelpState {
    pub scroll: usize,
}

impl HelpState {
    pub fn new() -> Self {
        Self { scroll: 0 }
    }

    pub fn handle_key(
        &mut self,
        key: KeyEvent,
        visible_rows: usize,
        total_rows: usize,
    ) -> HelpOutcome {
        let max_scroll = total_rows.saturating_sub(visible_rows);
        match key.code {
            KeyCode::Char('?') | KeyCode::Esc | KeyCode::Char('q') => HelpOutcome::Close,
            KeyCode::Down | KeyCode::Char('j') => {
                self.scroll = self.scroll.saturating_add(1).min(max_scroll);
                HelpOutcome::Continue
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll = self.scroll.saturating_sub(1);
                HelpOutcome::Continue
            }
            KeyCode::PageDown => {
                let step = visible_rows.max(1);
                self.scroll = self.scroll.saturating_add(step).min(max_scroll);
                HelpOutcome::Continue
            }
            KeyCode::PageUp => {
                let step = visible_rows.max(1);
                self.scroll = self.scroll.saturating_sub(step);
                HelpOutcome::Continue
            }
            _ => HelpOutcome::Continue,
        }
    }
}

fn truncate_to_width(text: &str, width: usize) -> String {
    text.chars().take(width).collect()
}

fn wrap_words(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut current = String::new();

    for word in text.split_whitespace() {
        let word_len = word.chars().count();
        if current.is_empty() {
            if word_len <= max_width {
                current.push_str(word);
            } else {
                let mut chars = word.chars();
                while chars.as_str().chars().count() > max_width {
                    let chunk: String = chars.by_ref().take(max_width).collect();
                    result.push(chunk);
                }
                current = chars.collect();
            }
        } else {
            let cur_len = current.chars().count();
            if cur_len + 1 + word_len <= max_width {
                current.push(' ');
                current.push_str(word);
            } else {
                result.push(current);
                current = String::new();
                if word_len <= max_width {
                    current.push_str(word);
                } else {
                    let mut chars = word.chars();
                    while chars.as_str().chars().count() > max_width {
                        let chunk: String = chars.by_ref().take(max_width).collect();
                        result.push(chunk);
                    }
                    current = chars.collect();
                }
            }
        }
    }

    if !current.is_empty() {
        result.push(current);
    }
    if result.is_empty() {
        result.push(String::new());
    }
    result
}

pub fn lines(width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut current_group: Option<&str> = None;

    for binding in BINDINGS {
        if current_group != Some(binding.group) {
            if current_group.is_some() {
                out.push(String::new());
            }
            current_group = Some(binding.group);
            out.push(truncate_to_width(binding.group, width));
        }

        if width >= 44 {
            let key_col = 20usize;
            let prefix = format!("  {:<width$}", binding.keys, width = key_col - 2);
            let prefix_len = prefix.chars().count();
            if prefix_len < width {
                let avail = width - prefix_len;
                let wrapped = wrap_words(binding.action, avail);
                for (i, part) in wrapped.into_iter().enumerate() {
                    if i == 0 {
                        out.push(truncate_to_width(&format!("{prefix}{part}"), width));
                    } else {
                        let indent = " ".repeat(prefix_len);
                        out.push(truncate_to_width(&format!("{indent}{part}"), width));
                    }
                }
            } else {
                out.push(truncate_to_width(&prefix, width));
            }
        } else {
            let combined = format!("  {} - {}", binding.keys, binding.action);
            let sub_avail = width.saturating_sub(2);
            if sub_avail == 0 {
                out.push(truncate_to_width(&combined, width));
            } else {
                let body = format!("{} - {}", binding.keys, binding.action);
                for part in wrap_words(&body, sub_avail) {
                    out.push(truncate_to_width(&format!("  {part}"), width));
                }
            }
        }
    }

    out
}

pub fn popup_rect(area: Rect) -> Rect {
    let available_width = area.width.saturating_sub(4);
    let width = if available_width < 24 {
        area.width
    } else {
        available_width.min(72)
    };
    let available_height = area.height.saturating_sub(2);
    let height = if available_height < 10 {
        area.height
    } else {
        available_height.min(32)
    };
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

pub fn render(frame: &mut Frame, area: Rect, state: &HelpState, palette: &Palette) {
    let popup = popup_rect(area);
    frame.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Help (? / Esc / q to close) ")
        .style(Style::default().fg(palette.text).bg(palette.panel_bg))
        .border_style(Style::default().fg(palette.border_focused));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let formatted = lines(inner.width as usize);
    let total_rows = formatted.len();
    let visible_rows = inner.height as usize;
    let max_scroll = total_rows.saturating_sub(visible_rows);
    let scroll = state.scroll.min(max_scroll);

    let styled_lines: Vec<Line> = formatted
        .into_iter()
        .skip(scroll)
        .take(visible_rows)
        .map(|line| {
            let is_heading = GROUP_ORDER.contains(&line.as_str());
            if is_heading {
                Line::from(Span::styled(
                    line,
                    Style::default()
                        .fg(palette.accent)
                        .add_modifier(Modifier::BOLD),
                ))
            } else {
                Line::from(Span::styled(line, Style::default().fg(palette.text)))
            }
        })
        .collect();

    frame.render_widget(
        Paragraph::new(styled_lines).style(Style::default().bg(palette.panel_bg)),
        inner,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;
    use std::collections::HashSet;

    #[test]
    fn no_duplicate_group_and_keys_pairs() {
        let mut seen = HashSet::new();
        for b in BINDINGS {
            assert!(
                seen.insert((b.group, b.keys)),
                "duplicate (group, keys) pair: ({}, {})",
                b.group,
                b.keys
            );
        }
    }

    #[test]
    fn groups_match_required_order_and_are_non_empty() {
        let mut observed_groups: Vec<&str> = Vec::new();
        for b in BINDINGS {
            if observed_groups.last().copied() != Some(b.group) {
                observed_groups.push(b.group);
            }
        }
        assert_eq!(observed_groups, GROUP_ORDER);
        for group in GROUP_ORDER {
            assert!(
                BINDINGS.iter().any(|b| b.group == *group),
                "group {group} has no rows"
            );
        }
    }

    #[test]
    fn every_new_binding_is_present() {
        let expected = [
            ("Runs", "/", "filter runs (type to narrow; space = AND)"),
            ("Runs", "a", "toggle active-only runs"),
            ("Run control", "p", "pause or resume the selected run"),
            ("Run control", "x", "cancel the selected run (asks y/N)"),
            ("Traces and source", "o", "open the run's agent traces"),
            (
                "Traces and source",
                "e",
                "edit the run's workflow source in $VISUAL/$EDITOR",
            ),
            ("Traces and source", "y", "copy the run id to the clipboard"),
            ("General", "?", "this help"),
            (
                "Graph",
                "arrows or hjkl",
                "move to the nearest node that way",
            ),
            ("Graph", "Shift+arrows", "pan the graph"),
            ("Graph", "n / N", "next / previous node"),
            ("Graph", "Enter", "show the selected node in the Inspector"),
        ];

        for (group, keys, action) in expected {
            assert!(
                BINDINGS
                    .iter()
                    .any(|b| b.group == group && b.keys == keys && b.action == action),
                "missing expected binding: ({group}, {keys}, {action})"
            );
        }
    }

    #[test]
    fn lines_never_exceed_width() {
        for width in [1, 5, 12, 20, 35, 44, 60, 80] {
            let rendered = lines(width);
            assert!(!rendered.is_empty());
            for line in &rendered {
                assert!(
                    line.chars().count() <= width,
                    "line {:?} ({} chars) exceeds width {}",
                    line,
                    line.chars().count(),
                    width
                );
            }
        }
        assert!(lines(0).is_empty());
    }

    #[test]
    fn scrolling_clamps_at_both_ends() {
        let mut state = HelpState::new();
        let visible = 10;
        let total = 25;

        assert_eq!(
            state.handle_key(
                KeyEvent::new(KeyCode::Up, KeyModifiers::NONE),
                visible,
                total
            ),
            HelpOutcome::Continue
        );
        assert_eq!(state.scroll, 0);

        assert_eq!(
            state.handle_key(
                KeyEvent::new(KeyCode::Char('k'), KeyModifiers::NONE),
                visible,
                total
            ),
            HelpOutcome::Continue
        );
        assert_eq!(state.scroll, 0);

        assert_eq!(
            state.handle_key(
                KeyEvent::new(KeyCode::Down, KeyModifiers::NONE),
                visible,
                total
            ),
            HelpOutcome::Continue
        );
        assert_eq!(state.scroll, 1);

        assert_eq!(
            state.handle_key(
                KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
                visible,
                total
            ),
            HelpOutcome::Continue
        );
        assert_eq!(state.scroll, 11);

        assert_eq!(
            state.handle_key(
                KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
                visible,
                total
            ),
            HelpOutcome::Continue
        );
        assert_eq!(state.scroll, 15);

        assert_eq!(
            state.handle_key(
                KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE),
                visible,
                total
            ),
            HelpOutcome::Continue
        );
        assert_eq!(state.scroll, 15);

        assert_eq!(
            state.handle_key(
                KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE),
                visible,
                total
            ),
            HelpOutcome::Continue
        );
        assert_eq!(state.scroll, 5);

        assert_eq!(
            state.handle_key(
                KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE),
                visible,
                total
            ),
            HelpOutcome::Continue
        );
        assert_eq!(state.scroll, 0);
    }

    #[test]
    fn close_keys_return_close() {
        let mut state = HelpState::new();
        for code in [KeyCode::Char('?'), KeyCode::Esc, KeyCode::Char('q')] {
            assert_eq!(
                state.handle_key(KeyEvent::new(code, KeyModifiers::NONE), 10, 30),
                HelpOutcome::Close
            );
        }
    }

    #[test]
    fn footer_constants_match_exact_text() {
        assert_eq!(
            FOOTER_KEYS,
            "f: follow  z: density  ,: theme  ?: help  q: quit"
        );
        assert_eq!(FOOTER_KEYS_EMPTY, " ,: theme  Tab: focus  ?: help  q: quit");
    }
}
