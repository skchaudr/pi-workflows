use std::time::{Duration, Instant};

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use unicode_width::UnicodeWidthChar;

use crate::format::sanitize_text;
use crate::theme::Palette;

pub const TTL: Duration = Duration::from_secs(4);
pub const ERROR_TTL: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub text: String,
    pub level: Level,
    pub raised: Instant,
}

impl Notice {
    pub fn info(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            level: Level::Info,
            raised: Instant::now(),
        }
    }

    pub fn warn(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            level: Level::Warn,
            raised: Instant::now(),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            level: Level::Error,
            raised: Instant::now(),
        }
    }

    pub fn expired_at(&self, now: Instant) -> bool {
        let ttl = match self.level {
            Level::Info | Level::Warn => TTL,
            Level::Error => ERROR_TTL,
        };
        now.saturating_duration_since(self.raised) >= ttl
    }
}

pub fn current(notice: &Option<Notice>, now: Instant) -> Option<&Notice> {
    notice.as_ref().filter(|n| !n.expired_at(now))
}

pub fn truncate_to_width(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }

    let mut total_width = 0usize;
    for ch in text.chars() {
        total_width = total_width.saturating_add(UnicodeWidthChar::width(ch).unwrap_or(0));
        if total_width > width {
            break;
        }
    }

    if total_width <= width {
        return text.to_string();
    }

    let target = width.saturating_sub(1);
    let mut out = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used.saturating_add(w) > target {
            break;
        }
        out.push(ch);
        used = used.saturating_add(w);
    }
    out.push('…');
    out
}

pub fn render(frame: &mut Frame, area: Rect, notice: &Notice, palette: &Palette) {
    if area.width == 0 || area.height == 0 {
        return;
    }

    let row = Rect {
        x: area.x,
        y: area.y + area.height - 1,
        width: area.width,
        height: 1,
    };

    let clean = sanitize_text(&notice.text);
    let truncated = truncate_to_width(&clean, usize::from(row.width));

    let fg = match notice.level {
        Level::Info => palette.success,
        Level::Warn => palette.warning,
        Level::Error => palette.error,
    };

    let widget = Paragraph::new(Line::from(Span::styled(
        truncated,
        Style::default().fg(fg).bg(palette.app_bg),
    )))
    .style(Style::default().bg(palette.app_bg));

    frame.render_widget(widget, row);
}

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_width::UnicodeWidthStr;

    #[test]
    fn expiry_boundaries_for_each_level() {
        let t0 = Instant::now();

        let info = Notice {
            text: "copied".into(),
            level: Level::Info,
            raised: t0,
        };
        assert!(!info.expired_at(t0));
        assert!(!info.expired_at(t0 + TTL - Duration::from_nanos(1)));
        assert!(info.expired_at(t0 + TTL));
        assert!(info.expired_at(t0 + TTL + Duration::from_secs(1)));

        let warn = Notice {
            text: "paused".into(),
            level: Level::Warn,
            raised: t0,
        };
        assert!(!warn.expired_at(t0));
        assert!(!warn.expired_at(t0 + TTL - Duration::from_nanos(1)));
        assert!(warn.expired_at(t0 + TTL));

        let err = Notice {
            text: "traces is not on PATH".into(),
            level: Level::Error,
            raised: t0,
        };
        assert!(!err.expired_at(t0));
        assert!(!err.expired_at(t0 + TTL));
        assert!(!err.expired_at(t0 + ERROR_TTL - Duration::from_nanos(1)));
        assert!(err.expired_at(t0 + ERROR_TTL));
        assert!(err.expired_at(t0 + ERROR_TTL + Duration::from_secs(1)));
    }

    #[test]
    fn current_returns_none_after_expiry() {
        let t0 = Instant::now();
        let none: Option<Notice> = None;
        assert_eq!(current(&none, t0), None);

        let some_info = Some(Notice {
            text: "ok".into(),
            level: Level::Info,
            raised: t0,
        });
        assert!(current(&some_info, t0).is_some());
        assert!(current(&some_info, t0 + TTL - Duration::from_millis(1)).is_some());
        assert_eq!(current(&some_info, t0 + TTL), None);

        let some_err = Some(Notice {
            text: "boom".into(),
            level: Level::Error,
            raised: t0,
        });
        assert!(current(&some_err, t0 + TTL).is_some());
        assert_eq!(current(&some_err, t0 + ERROR_TTL), None);
    }

    #[test]
    fn truncate_to_width_ascii_cjk_emoji_and_small_widths() {
        assert_eq!(truncate_to_width("hello", 0), "");
        assert_eq!(truncate_to_width("", 0), "");
        assert_eq!(truncate_to_width("", 5), "");

        assert_eq!(truncate_to_width("a", 1), "a");
        assert_eq!(truncate_to_width("ab", 1), "…");
        assert_eq!(truncate_to_width("hello", 5), "hello");
        assert_eq!(truncate_to_width("hello world", 5), "hell…");

        // CJK wide characters (each width 2)
        let cjk = "日本語";
        assert_eq!(truncate_to_width(cjk, 0), "");
        assert_eq!(truncate_to_width(cjk, 1), "…");
        assert_eq!(truncate_to_width(cjk, 2), "…");
        assert_eq!(truncate_to_width(cjk, 3), "日…");
        assert_eq!(truncate_to_width(cjk, 4), "日…");
        assert_eq!(truncate_to_width(cjk, 5), "日本…");
        assert_eq!(truncate_to_width(cjk, 6), "日本語");
        assert!(UnicodeWidthStr::width(truncate_to_width(cjk, 4).as_str()) <= 4);

        // Emoji (width 2)
        let emoji = "🦀🦀";
        assert_eq!(truncate_to_width(emoji, 0), "");
        assert_eq!(truncate_to_width(emoji, 1), "…");
        assert_eq!(truncate_to_width(emoji, 2), "…");
        assert_eq!(truncate_to_width(emoji, 3), "🦀…");
        assert_eq!(truncate_to_width(emoji, 4), "🦀🦀");
    }
}
