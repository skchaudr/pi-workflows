use crate::format::sanitize_text;
use crate::theme::Palette;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Neutral,
    Running,
    Success,
    Warning,
    Error,
}

impl Level {
    fn color(self, palette: &Palette) -> Color {
        match self {
            Level::Neutral => palette.subtext,
            Level::Running => palette.running,
            Level::Success => palette.success,
            Level::Warning => palette.warning,
            Level::Error => palette.error,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeDetail {
    pub node_id: String,
    pub node_type: String,
    pub status: String,
    pub level: Level,
    pub fields: Vec<(String, String)>,
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeModalState {
    pub scroll: usize,
}

impl Default for NodeModalState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModalOutcome {
    Continue,
    Close,
    Prev,
    Next,
}

impl NodeModalState {
    pub fn new() -> Self {
        Self { scroll: 0 }
    }

    pub fn reset(&mut self) {
        self.scroll = 0;
    }

    pub fn handle_key(
        &mut self,
        key: KeyEvent,
        visible_rows: usize,
        total_rows: usize,
    ) -> ModalOutcome {
        let max_scroll = total_rows.saturating_sub(visible_rows);
        let page_step = visible_rows.saturating_sub(1).max(1);

        match key.code {
            KeyCode::Left | KeyCode::Char('h') | KeyCode::BackTab => ModalOutcome::Prev,
            KeyCode::Right | KeyCode::Char('l') | KeyCode::Tab => ModalOutcome::Next,
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter | KeyCode::Char(' ') => {
                ModalOutcome::Close
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.scroll = self.scroll.saturating_add(1).min(max_scroll);
                ModalOutcome::Continue
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll = self.scroll.min(max_scroll).saturating_sub(1);
                ModalOutcome::Continue
            }
            KeyCode::PageDown => {
                self.scroll = self.scroll.saturating_add(page_step).min(max_scroll);
                ModalOutcome::Continue
            }
            KeyCode::PageUp => {
                self.scroll = self.scroll.min(max_scroll).saturating_sub(page_step);
                ModalOutcome::Continue
            }
            KeyCode::Home | KeyCode::Char('g') => {
                self.scroll = 0;
                ModalOutcome::Continue
            }
            KeyCode::End | KeyCode::Char('G') => {
                self.scroll = max_scroll;
                ModalOutcome::Continue
            }
            _ => {
                self.scroll = self.scroll.min(max_scroll);
                ModalOutcome::Continue
            }
        }
    }
}

pub fn popup_rect(area: Rect) -> Rect {
    let target_width = ((area.width as u32 * 70) / 100) as u16;
    let width = target_width.clamp(40, 100).min(area.width);

    let target_height = ((area.height as u32 * 70) / 100) as u16;
    let height = target_height.max(10).min(area.height);

    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

pub fn body_size(area: Rect) -> (usize, usize) {
    let popup = popup_rect(area);
    let inner_w = popup.width.saturating_sub(2) as usize;
    let inner_h = popup.height.saturating_sub(2) as usize;
    (inner_w, inner_h)
}

fn wrap_plain(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return Vec::new();
    }
    if text.is_empty() {
        return vec![String::new()];
    }

    let mut result = Vec::new();
    let mut current = String::new();
    let mut current_w = 0;

    for word in text.split_inclusive(' ') {
        let word_w = UnicodeWidthStr::width(word);
        if current_w == 0 && word_w <= max_width {
            current.push_str(word);
            current_w = word_w;
        } else if current_w > 0 && current_w + word_w <= max_width {
            current.push_str(word);
            current_w += word_w;
        } else {
            let trimmed_word = word.trim_end_matches(' ');
            let trimmed_w = UnicodeWidthStr::width(trimmed_word);
            if current_w > 0 && current_w + trimmed_w <= max_width {
                current.push_str(trimmed_word);
                result.push(std::mem::take(&mut current));
                current_w = 0;
                continue;
            }

            if current_w > 0 {
                let trimmed_line = current.trim_end_matches(' ').to_string();
                result.push(trimmed_line);
                current.clear();
                current_w = 0;
            }

            let target = if word_w <= max_width {
                word
            } else {
                trimmed_word
            };
            // U+FE0F widens the preceding char after the fact; drop it when splitting by char.
            for ch in target.chars().filter(|ch| *ch != '\u{fe0f}') {
                let cw = UnicodeWidthChar::width(ch).unwrap_or(0);
                if cw > max_width {
                    if current_w > 0 {
                        result.push(std::mem::take(&mut current));
                        current_w = 0;
                    }
                    result.push(".".repeat(max_width));
                    continue;
                }
                if current_w + cw > max_width && current_w > 0 {
                    result.push(std::mem::take(&mut current));
                    current_w = 0;
                }
                current.push(ch);
                current_w += cw;
            }
        }
    }

    if !current.is_empty() || result.is_empty() {
        result.push(current);
    }

    result
}

fn truncate_to_width(text: &str, max_width: usize) -> String {
    let mut out = String::new();
    let mut w = 0;
    for ch in text.chars() {
        let cw = UnicodeWidthChar::width(ch).unwrap_or(0);
        if w + cw > max_width {
            break;
        }
        out.push(ch);
        w += cw;
    }
    out
}

pub fn lines(detail: &NodeDetail, width: usize, palette: &Palette) -> Vec<Line<'static>> {
    if width == 0 {
        return Vec::new();
    }

    let status_val = sanitize_text(&detail.status);
    let type_val = sanitize_text(&detail.node_type);
    let sanitized_fields: Vec<(String, String)> = detail
        .fields
        .iter()
        .map(|(k, v)| (sanitize_text(k), sanitize_text(v)))
        .collect();

    let mut rows: Vec<(String, String, Style)> = Vec::new();
    rows.push((
        "status".to_string(),
        status_val,
        Style::default()
            .fg(detail.level.color(palette))
            .add_modifier(Modifier::BOLD),
    ));
    if !type_val.trim().is_empty() {
        rows.push((
            "type".to_string(),
            type_val,
            Style::default().fg(palette.text),
        ));
    }
    for (k, v) in sanitized_fields {
        rows.push((k, v, Style::default().fg(palette.text)));
    }

    let max_label_w = rows
        .iter()
        .map(|(k, _, _)| UnicodeWidthStr::width(k.as_str()))
        .max()
        .unwrap_or(6)
        .max(6);

    let mut out: Vec<Line<'static>> = Vec::new();
    let label_style = Style::default().fg(palette.muted);

    let side_by_side = max_label_w + 2 < width;
    let label_col_w = if side_by_side { max_label_w + 2 } else { 0 };
    let val_col_w = if side_by_side {
        width - label_col_w
    } else {
        width
    };

    for (label, value, val_style) in rows {
        if side_by_side {
            let lw = UnicodeWidthStr::width(label.as_str());
            let pad = " ".repeat(label_col_w.saturating_sub(lw));
            let prefix_first = format!("{label}{pad}");
            let prefix_cont = " ".repeat(label_col_w);
            let wrapped_vals = wrap_plain(&value, val_col_w);
            for (idx, vline) in wrapped_vals.into_iter().enumerate() {
                let pfx = if idx == 0 {
                    prefix_first.clone()
                } else {
                    prefix_cont.clone()
                };
                out.push(Line::from(vec![
                    Span::styled(pfx, label_style),
                    Span::styled(vline, val_style),
                ]));
            }
        } else {
            let combined = if value.is_empty() {
                label
            } else {
                format!("{label}  {value}")
            };
            for line_str in wrap_plain(&combined, width) {
                out.push(Line::from(Span::styled(line_str, val_style)));
            }
        }
    }

    let heading_style = Style::default()
        .fg(palette.accent)
        .add_modifier(Modifier::BOLD);
    let body_style = Style::default().fg(palette.text);
    let empty_style = Style::default().fg(palette.muted);

    for section in &detail.sections {
        out.push(Line::from(""));

        let clean_title = sanitize_text(&section.title);
        let full_heading = format!("── {clean_title} ──");
        let heading_text = if UnicodeWidthStr::width(full_heading.as_str()) <= width {
            full_heading
        } else {
            truncate_to_width(&full_heading, width)
        };
        for hline in wrap_plain(&heading_text, width) {
            out.push(Line::from(Span::styled(hline, heading_style)));
        }

        let has_content = section
            .body
            .lines()
            .any(|l| !sanitize_text(l).trim().is_empty());

        if !has_content {
            for eline in wrap_plain("—", width) {
                out.push(Line::from(Span::styled(eline, empty_style)));
            }
        } else {
            for raw_line in section.body.split('\n') {
                let raw_line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
                let clean_line = sanitize_text(raw_line);
                for bline in wrap_plain(&clean_line, width) {
                    out.push(Line::from(Span::styled(bline, body_style)));
                }
            }
        }
    }

    out
}

pub fn render(
    frame: &mut Frame,
    area: Rect,
    detail: &NodeDetail,
    state: &NodeModalState,
    position: (usize, usize),
    palette: &Palette,
) {
    let popup = popup_rect(area);
    if popup.width == 0 || popup.height == 0 {
        return;
    }

    frame.render_widget(Clear, popup);

    let clean_id = sanitize_text(&detail.node_id);
    let top_title = if position.1 == 0 {
        format!(" {clean_id} ")
    } else {
        format!(" {clean_id} · {}/{} ", position.0, position.1)
    };

    const LONG_BOTTOM: &str = " ←/h prev · →/l next · j/k scroll · Esc close ";
    const SHORT_BOTTOM: &str = " ←→ node · Esc close ";
    let long_w = UnicodeWidthStr::width(LONG_BOTTOM) as u16;
    let bottom_title = if popup.width >= long_w.saturating_add(2) {
        LONG_BOTTOM
    } else {
        SHORT_BOTTOM
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .title_top(Line::from(Span::styled(
            top_title,
            Style::default()
                .fg(palette.text)
                .add_modifier(Modifier::BOLD),
        )))
        .title_bottom(Line::from(Span::styled(
            bottom_title,
            Style::default().fg(palette.subtext),
        )))
        .style(Style::default().fg(palette.text).bg(palette.panel_bg))
        .border_style(Style::default().fg(palette.border_focused));

    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let rendered_lines = lines(detail, inner.width as usize, palette);
    let total_rows = rendered_lines.len();
    let visible_rows = inner.height as usize;
    let max_scroll = total_rows.saturating_sub(visible_rows);
    let clamped_scroll = state.scroll.min(max_scroll);

    let visible_slice: Vec<Line<'static>> = rendered_lines
        .into_iter()
        .skip(clamped_scroll)
        .take(visible_rows)
        .collect();

    let paragraph =
        Paragraph::new(visible_slice).style(Style::default().fg(palette.text).bg(palette.panel_bg));
    frame.render_widget(paragraph, inner);

    let indicator_style = Style::default()
        .fg(palette.accent)
        .bg(palette.panel_bg)
        .add_modifier(Modifier::BOLD);

    if clamped_scroll > 0 {
        let up_rect = Rect::new(inner.right().saturating_sub(1), inner.y, 1, 1);
        frame.render_widget(Paragraph::new("▲").style(indicator_style), up_rect);
    }

    if clamped_scroll + visible_rows < total_rows {
        let down_rect = Rect::new(
            inner.right().saturating_sub(1),
            inner.bottom().saturating_sub(1),
            1,
            1,
        );
        frame.render_widget(Paragraph::new("▼").style(indicator_style), down_rect);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn line_width(line: &Line<'_>) -> usize {
        let combined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        UnicodeWidthStr::width(combined.as_str())
    }

    fn line_text(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn key_mappings_produce_expected_outcomes() {
        let mut state = NodeModalState::new();

        assert_eq!(state.handle_key(key(KeyCode::Left), 10, 30), ModalOutcome::Prev);
        assert_eq!(
            state.handle_key(key(KeyCode::Char('h')), 10, 30),
            ModalOutcome::Prev
        );
        assert_eq!(
            state.handle_key(key(KeyCode::BackTab), 10, 30),
            ModalOutcome::Prev
        );

        assert_eq!(
            state.handle_key(key(KeyCode::Right), 10, 30),
            ModalOutcome::Next
        );
        assert_eq!(
            state.handle_key(key(KeyCode::Char('l')), 10, 30),
            ModalOutcome::Next
        );
        assert_eq!(
            state.handle_key(key(KeyCode::Tab), 10, 30),
            ModalOutcome::Next
        );

        assert_eq!(
            state.handle_key(key(KeyCode::Esc), 10, 30),
            ModalOutcome::Close
        );
        assert_eq!(
            state.handle_key(key(KeyCode::Char('q')), 10, 30),
            ModalOutcome::Close
        );
        assert_eq!(
            state.handle_key(key(KeyCode::Enter), 10, 30),
            ModalOutcome::Close
        );
        assert_eq!(
            state.handle_key(key(KeyCode::Char(' ')), 10, 30),
            ModalOutcome::Close
        );

        assert_eq!(
            state.handle_key(key(KeyCode::Char('x')), 10, 30),
            ModalOutcome::Continue
        );
    }

    #[test]
    fn scrolling_and_clamping_work_at_boundaries() {
        let mut state = NodeModalState::new();
        // visible = 5, total = 12 -> max_scroll = 7, page_step = 4
        assert_eq!(
            state.handle_key(key(KeyCode::Up), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 0);

        assert_eq!(
            state.handle_key(key(KeyCode::Down), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 1);

        assert_eq!(
            state.handle_key(key(KeyCode::Char('j')), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 2);

        assert_eq!(
            state.handle_key(key(KeyCode::Char('k')), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 1);

        assert_eq!(
            state.handle_key(key(KeyCode::PageDown), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 5);

        assert_eq!(
            state.handle_key(key(KeyCode::PageDown), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 7);

        assert_eq!(
            state.handle_key(key(KeyCode::Down), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 7);

        assert_eq!(
            state.handle_key(key(KeyCode::PageUp), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 3);

        assert_eq!(
            state.handle_key(key(KeyCode::Char('g')), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 0);

        assert_eq!(
            state.handle_key(key(KeyCode::Char('G')), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 7);

        assert_eq!(
            state.handle_key(key(KeyCode::Home), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 0);

        assert_eq!(
            state.handle_key(key(KeyCode::End), 5, 12),
            ModalOutcome::Continue
        );
        assert_eq!(state.scroll, 7);

        state.reset();
        assert_eq!(state.scroll, 0);

        // total_rows < visible_rows
        state.scroll = 10;
        state.handle_key(key(KeyCode::Down), 10, 4);
        assert_eq!(state.scroll, 0);

        // visible_rows == 0 (page_step = max(0, 1) = 1, max_scroll = 5)
        state.handle_key(key(KeyCode::PageDown), 0, 5);
        assert_eq!(state.scroll, 1);
    }

    #[test]
    fn popup_rect_and_body_size_handle_tiny_and_large_areas() {
        let zero = Rect::new(0, 0, 0, 0);
        let p_zero = popup_rect(zero);
        assert_eq!(p_zero, Rect::new(0, 0, 0, 0));
        assert_eq!(body_size(zero), (0, 0));

        let tiny = Rect::new(2, 1, 5, 3);
        let p_tiny = popup_rect(tiny);
        assert!(p_tiny.x >= tiny.x);
        assert!(p_tiny.y >= tiny.y);
        assert!(p_tiny.right() <= tiny.right());
        assert!(p_tiny.bottom() <= tiny.bottom());
        assert_eq!(body_size(tiny), (3, 1));

        let large = Rect::new(0, 0, 200, 60);
        let p_large = popup_rect(large);
        assert!(p_large.width <= 100);
        assert!(p_large.width >= 40);
        assert_eq!(p_large.height, 42);
        assert!(p_large.x > 0 && p_large.y > 0);
        assert!(p_large.right() <= large.right());
        assert!(p_large.bottom() <= large.bottom());
        assert_eq!(
            body_size(large),
            ((p_large.width - 2) as usize, (p_large.height - 2) as usize)
        );
    }

    #[test]
    fn lines_never_exceed_width_for_ascii_cjk_and_emoji() {
        let palette = Palette::catppuccin();
        let detail = NodeDetail {
            node_id: "node-1".to_string(),
            node_type: "agent".to_string(),
            status: "completed".to_string(),
            level: Level::Success,
            fields: vec![
                ("attempts".to_string(), "2".to_string()),
                (
                    "branch".to_string(),
                    "ok -> deploy_production_environment_now".to_string(),
                ),
                ("cjk_label".to_string(), "日本語のテスト文字列です".to_string()),
                ("emoji".to_string(), "🚀🔥✨🎉🛠️📦".to_string()),
            ],
            sections: vec![
                Section {
                    title: "prompt 日本語 🚀".to_string(),
                    body: "First line with supercalifragilisticexpialidocious word\n漢字とかな混じりの長い文章を折り返すテスト🚀🔥✨".to_string(),
                },
                Section {
                    title: "empty".to_string(),
                    body: "".to_string(),
                },
            ],
        };

        assert!(lines(&detail, 0, &palette).is_empty());

        for &width in &[1usize, 8, 20, 80] {
            let rendered = lines(&detail, width, &palette);
            assert!(!rendered.is_empty());
            for line in &rendered {
                let w = line_width(line);
                assert!(
                    w <= width,
                    "Line {:?} has width {} which exceeds max width {}",
                    line_text(line),
                    w,
                    width
                );
            }
        }
    }

    #[test]
    fn sections_preserve_line_breaks_show_em_dash_when_empty_and_strip_ansi() {
        let palette = Palette::catppuccin();
        let detail = NodeDetail {
            node_id: "n".to_string(),
            node_type: "".to_string(),
            status: "failed \x1b[31mred\x1b[0m".to_string(),
            level: Level::Error,
            fields: vec![("key".to_string(), "val\x1b[2J".to_string())],
            sections: vec![
                Section {
                    title: "output".to_string(),
                    body: "alpha line\nbeta \x1b[32mline\x1b[0m\ngamma line".to_string(),
                },
                Section {
                    title: "error".to_string(),
                    body: "".to_string(),
                },
            ],
        };

        let rendered = lines(&detail, 80, &palette);
        let texts: Vec<String> = rendered.iter().map(line_text).collect();

        for t in &texts {
            assert!(
                !t.contains('\x1b'),
                "Line still contains ESC byte: {:?}",
                t
            );
        }

        // Empty node_type is omitted
        assert!(!texts.iter().any(|t| t.starts_with("type")));

        // Line breaks in section body are preserved as distinct lines
        let alpha_pos = texts.iter().position(|t| t == "alpha line");
        let beta_pos = texts.iter().position(|t| t == "beta line");
        let gamma_pos = texts.iter().position(|t| t == "gamma line");
        assert!(alpha_pos.is_some());
        assert_eq!(beta_pos, alpha_pos.map(|i| i + 1));
        assert_eq!(gamma_pos, alpha_pos.map(|i| i + 2));

        // Empty section shows "—"
        let error_heading_pos = texts.iter().position(|t| t == "── error ──").unwrap();
        assert_eq!(texts.get(error_heading_pos + 1).map(String::as_str), Some("—"));
    }
}
