use super::theme_picker::popup_rect;
use crate::format::sanitize_text;
use crate::theme::Palette;
use crate::trace_match::TraceRecord;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

#[derive(Debug, Clone, PartialEq)]
pub struct TracePicker {
    pub records: Vec<TraceRecord>,
    pub selected: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickerOutcome {
    Pick(String),
    Close,
    Continue,
}

impl TracePicker {
    pub fn new(records: Vec<TraceRecord>) -> Self {
        Self {
            records,
            selected: 0,
        }
    }

    pub fn move_previous(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub fn move_next(&mut self) {
        if !self.records.is_empty() {
            self.selected = (self.selected + 1).min(self.records.len() - 1);
        } else {
            self.selected = 0;
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> PickerOutcome {
        if matches!(key.kind, KeyEventKind::Release) {
            return PickerOutcome::Continue;
        }
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.move_previous();
                PickerOutcome::Continue
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.move_next();
                PickerOutcome::Continue
            }
            KeyCode::Enter => match self.selected_id() {
                Some(id) => PickerOutcome::Pick(id.to_string()),
                None => PickerOutcome::Close,
            },
            KeyCode::Esc => PickerOutcome::Close,
            _ => PickerOutcome::Continue,
        }
    }

    pub fn selected_id(&self) -> Option<&str> {
        self.records.get(self.selected).map(|r| r.id.as_str())
    }
}

pub fn row_text(record: &TraceRecord, width: usize) -> String {
    if width == 0 {
        return String::new();
    }

    let status_clean = sanitize_text(&record.status);
    let status = if status_clean.trim().is_empty() {
        "-"
    } else {
        status_clean.as_str()
    };

    let model_clean = sanitize_text(&record.model);
    let model = if model_clean.trim().is_empty() {
        "-"
    } else {
        model_clean.as_str()
    };

    let title_clean = sanitize_text(&record.title);
    let title = if title_clean.trim().is_empty() {
        "-"
    } else {
        title_clean.as_str()
    };

    let full = format!("▌ {status}  {model}  {title}");
    truncate_to_width(&full, width)
}

fn truncate_to_width(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(text) <= max_width {
        return text.to_string();
    }
    let ellipsis = '…';
    let ellipsis_width = UnicodeWidthChar::width(ellipsis).unwrap_or(1);
    if max_width <= ellipsis_width {
        return ellipsis.to_string();
    }

    let target = max_width - ellipsis_width;
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + ch_width > target {
            break;
        }
        out.push(ch);
        used += ch_width;
    }
    out.push(ellipsis);
    out
}

pub fn render(frame: &mut Frame, area: Rect, picker: &TracePicker, palette: &Palette) {
    let popup = popup_rect(area);
    frame.render_widget(Clear, popup);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Traces (j/k, enter, esc) ")
        .style(Style::default().fg(palette.text).bg(palette.panel_bg))
        .border_style(Style::default().fg(palette.border_focused));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);
    if inner.height == 0 || inner.width == 0 {
        return;
    }

    let footer_height = if inner.height >= 3 { 1 } else { 0 };
    let list_height = inner.height.saturating_sub(footer_height);
    let list_area = Rect::new(inner.x, inner.y, inner.width, list_height);
    let row_width = usize::from(list_area.width);

    let items: Vec<ListItem> = picker
        .records
        .iter()
        .map(|record| {
            let text = row_text(record, row_width);
            ListItem::new(Line::from(Span::styled(
                text,
                Style::default().fg(palette.text),
            )))
        })
        .collect();

    let list = List::new(items)
        .style(Style::default().fg(palette.text).bg(palette.panel_bg))
        .highlight_style(
            Style::default()
                .fg(palette.text)
                .bg(palette.selection_bg)
                .add_modifier(Modifier::BOLD),
        );

    let selected = if picker.records.is_empty() {
        None
    } else {
        Some(picker.selected.min(picker.records.len() - 1))
    };
    let mut state = ListState::default().with_selected(selected);
    frame.render_stateful_widget(list, list_area, &mut state);

    if footer_height > 0 {
        let footer_area = Rect::new(inner.x, inner.y + list_height, inner.width, footer_height);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("↑↓/jk", Style::default().fg(palette.accent)),
                Span::styled(" Select  ", Style::default().fg(palette.subtext)),
                Span::styled("Enter", Style::default().fg(palette.accent)),
                Span::styled(" Open  ", Style::default().fg(palette.subtext)),
                Span::styled("Esc", Style::default().fg(palette.accent)),
                Span::styled(" Cancel", Style::default().fg(palette.subtext)),
            ]))
            .style(Style::default().bg(palette.panel_bg)),
            footer_area,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn sample_record(id: &str, status: &str, model: &str, title: &str) -> TraceRecord {
        TraceRecord {
            id: id.to_string(),
            status: status.to_string(),
            model: model.to_string(),
            title: title.to_string(),
            path: format!("/tmp/{id}.jsonl"),
        }
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn movement_clamps_within_bounds() {
        let records = vec![
            sample_record("pi:1", "active", "model-a", "first"),
            sample_record("pi:2", "idle", "model-b", "second"),
            sample_record("pi:3", "idle", "model-c", "third"),
        ];
        let mut picker = TracePicker::new(records);
        assert_eq!(picker.selected, 0);
        assert_eq!(picker.selected_id(), Some("pi:1"));

        picker.move_previous();
        assert_eq!(picker.selected, 0);

        picker.move_next();
        assert_eq!(picker.selected, 1);
        assert_eq!(picker.selected_id(), Some("pi:2"));

        picker.move_next();
        assert_eq!(picker.selected, 2);
        assert_eq!(picker.selected_id(), Some("pi:3"));

        picker.move_next();
        assert_eq!(picker.selected, 2);

        picker.move_previous();
        assert_eq!(picker.selected, 1);
    }

    #[test]
    fn handles_every_key_correctly() {
        let records = vec![
            sample_record("pi:1", "active", "m1", "t1"),
            sample_record("pi:2", "idle", "m2", "t2"),
        ];
        let mut picker = TracePicker::new(records);

        assert_eq!(
            picker.handle_key(key(KeyCode::Down)),
            PickerOutcome::Continue
        );
        assert_eq!(picker.selected, 1);

        assert_eq!(picker.handle_key(key(KeyCode::Up)), PickerOutcome::Continue);
        assert_eq!(picker.selected, 0);

        assert_eq!(
            picker.handle_key(key(KeyCode::Char('j'))),
            PickerOutcome::Continue
        );
        assert_eq!(picker.selected, 1);

        assert_eq!(
            picker.handle_key(key(KeyCode::Char('k'))),
            PickerOutcome::Continue
        );
        assert_eq!(picker.selected, 0);

        assert_eq!(
            picker.handle_key(key(KeyCode::Char('x'))),
            PickerOutcome::Continue
        );
        assert_eq!(picker.selected, 0);

        assert_eq!(
            picker.handle_key(key(KeyCode::Enter)),
            PickerOutcome::Pick("pi:1".to_string())
        );

        assert_eq!(picker.handle_key(key(KeyCode::Esc)), PickerOutcome::Close);
    }

    #[test]
    fn empty_records_selects_none_and_enter_closes() {
        let mut picker = TracePicker::new(Vec::new());
        assert_eq!(picker.selected_id(), None);

        picker.move_previous();
        assert_eq!(picker.selected, 0);
        picker.move_next();
        assert_eq!(picker.selected, 0);

        assert_eq!(picker.handle_key(key(KeyCode::Enter)), PickerOutcome::Close);
        assert_eq!(picker.handle_key(key(KeyCode::Esc)), PickerOutcome::Close);
    }

    #[test]
    fn row_text_formats_and_truncates_safely() {
        let record = sample_record(
            "pi:1",
            "active",
            "gemini-3.8-flash-high",
            "block:01a1da95-9999",
        );
        let full = row_text(&record, 100);
        assert_eq!(full, "▌ active  gemini-3.8-flash-high  block:01a1da95-9999");

        let truncated = row_text(&record, 42);
        assert_eq!(truncated, "▌ active  gemini-3.8-flash-high  block:01…");
        assert_eq!(UnicodeWidthStr::width(truncated.as_str()), 42);

        assert_eq!(row_text(&record, 0), "");
        assert_eq!(row_text(&record, 1), "…");
        assert_eq!(row_text(&record, 2), "▌…");
    }

    #[test]
    fn row_text_handles_empty_fields_and_wide_characters() {
        let empty_fields = sample_record("pi:2", "idle", "", "");
        assert_eq!(row_text(&empty_fields, 80), "▌ idle  -  -");

        let wide = sample_record("pi:3", "active", "m", "日本語タイトル");
        // "▌ active  m  " is 13 columns, each CJK char is 2 columns.
        // At width 16: 13 + 2 ("日") + 1 ("…") = 16 columns.
        let truncated_wide = row_text(&wide, 16);
        assert_eq!(truncated_wide, "▌ active  m  日…");
        assert!(UnicodeWidthStr::width(truncated_wide.as_str()) <= 16);

        // At width 15: 13 + 0 (cannot fit "日" before "…") + 1 ("…") = 14 columns.
        let truncated_boundary = row_text(&wide, 15);
        assert_eq!(truncated_boundary, "▌ active  m  …");
        assert!(UnicodeWidthStr::width(truncated_boundary.as_str()) <= 15);
    }

    #[test]
    fn renders_popup_with_title_and_selection_highlight() {
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).expect("in-memory terminal");
        let palette = Palette::catppuccin();
        let picker = TracePicker::new(vec![
            sample_record("pi:1", "active", "m1", "first"),
            sample_record("pi:2", "idle", "m2", "second"),
        ]);

        terminal
            .draw(|frame| {
                let area = frame.area();
                render(frame, area, &picker, &palette);
            })
            .expect("draw succeeds");

        let buffer = terminal.backend().buffer();
        let popup = popup_rect(Rect::new(0, 0, 80, 24));
        let top_row: String = (popup.x..popup.right())
            .map(|x| buffer[(x, popup.y)].symbol())
            .collect();
        assert!(top_row.contains("Traces (j/k, enter, esc)"));

        let first_item_cell = &buffer[(popup.x + 1, popup.y + 1)];
        assert_eq!(first_item_cell.bg, palette.selection_bg);
    }
}
