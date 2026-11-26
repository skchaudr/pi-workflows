use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Direction, Layout, Rect};

const MIN_SIDEBAR_WIDTH: u16 = 12;
const MIN_MAIN_WIDTH: u16 = 24;
const COLLAPSED_SIDEBAR_WIDTH: u16 = 8;
const MIN_PANE_HEIGHT: u16 = 8;
const SPLIT_RESIZE_STEP: u16 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneId {
    Runs,
    Graph,
    Inspector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ZoomMode {
    #[default]
    Split,
    Maximized(PaneId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BodyRects {
    pub runs_rect: Rect,
    pub main_rect: Rect,
    pub graph_rect: Rect,
    pub inspector_rect: Rect,
    pub sidebar_collapsed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoomKeyAction {
    ToggleMaximizeFocused,
    ToggleMaximizeGraph,
    RestoreSplit,
    GrowGraph(u16),
    ShrinkGraph(u16),
}

/// Classify a key event into a `ZoomKeyAction` when applicable.
///
/// Rules:
/// - `KeyCode::Char('m') | KeyCode::Char('M')` (without CONTROL/ALT) -> `Some(ZoomKeyAction::ToggleMaximizeFocused)`
/// - `KeyCode::Char('Z')` (without CONTROL/ALT) -> `Some(ZoomKeyAction::ToggleMaximizeGraph)`
/// - `KeyCode::Esc` when `zoom != ZoomMode::Split` -> `Some(ZoomKeyAction::RestoreSplit)`
/// - `KeyCode::Char('j')` with `ALT`, or `KeyCode::Down` with `CONTROL` or `ALT` -> `Some(ZoomKeyAction::GrowGraph(3))`
/// - `KeyCode::Char('k')` with `ALT`, or `KeyCode::Up` with `CONTROL` or `ALT` -> `Some(ZoomKeyAction::ShrinkGraph(3))`
/// - Otherwise -> `None`
pub fn classify_zoom_key(key: KeyEvent, zoom: ZoomMode) -> Option<ZoomKeyAction> {
    let has_ctrl_or_alt = key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);

    match key.code {
        KeyCode::Char('m') | KeyCode::Char('M') if !has_ctrl_or_alt => {
            Some(ZoomKeyAction::ToggleMaximizeFocused)
        }
        KeyCode::Char('Z') if !has_ctrl_or_alt => Some(ZoomKeyAction::ToggleMaximizeGraph),
        KeyCode::Esc if zoom != ZoomMode::Split => Some(ZoomKeyAction::RestoreSplit),
        KeyCode::Char('j') if key.modifiers.contains(KeyModifiers::ALT) => {
            Some(ZoomKeyAction::GrowGraph(SPLIT_RESIZE_STEP))
        }
        KeyCode::Down if has_ctrl_or_alt => Some(ZoomKeyAction::GrowGraph(SPLIT_RESIZE_STEP)),
        KeyCode::Char('k') if key.modifiers.contains(KeyModifiers::ALT) => {
            Some(ZoomKeyAction::ShrinkGraph(SPLIT_RESIZE_STEP))
        }
        KeyCode::Up if has_ctrl_or_alt => Some(ZoomKeyAction::ShrinkGraph(SPLIT_RESIZE_STEP)),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneLayoutState {
    pub zoom: ZoomMode,
    pub graph_height_delta: i16,
    pub sidebar_hidden: bool,
}

impl Default for PaneLayoutState {
    fn default() -> Self {
        Self {
            zoom: ZoomMode::Split,
            graph_height_delta: 0,
            sidebar_hidden: false,
        }
    }
}

impl PaneLayoutState {
    pub fn apply_action(&mut self, action: ZoomKeyAction, focused: PaneId) {
        match action {
            ZoomKeyAction::ToggleMaximizeFocused => {
                if self.zoom == ZoomMode::Maximized(focused) {
                    self.zoom = ZoomMode::Split;
                } else {
                    self.zoom = ZoomMode::Maximized(focused);
                }
            }
            ZoomKeyAction::ToggleMaximizeGraph => {
                if self.zoom == ZoomMode::Maximized(PaneId::Graph) {
                    self.zoom = ZoomMode::Split;
                } else {
                    self.zoom = ZoomMode::Maximized(PaneId::Graph);
                }
            }
            ZoomKeyAction::RestoreSplit => {
                self.zoom = ZoomMode::Split;
            }
            ZoomKeyAction::GrowGraph(step) => {
                let delta = i16::try_from(step).unwrap_or(i16::MAX);
                self.graph_height_delta = self.graph_height_delta.saturating_add(delta);
            }
            ZoomKeyAction::ShrinkGraph(step) => {
                let delta = i16::try_from(step).unwrap_or(i16::MAX);
                self.graph_height_delta = self.graph_height_delta.saturating_sub(delta);
            }
        }
    }

    pub fn toggle_sidebar_hidden(&mut self) {
        self.sidebar_hidden = !self.sidebar_hidden;
    }

    pub fn status_badge(&self) -> Option<&'static str> {
        match self.zoom {
            ZoomMode::Maximized(PaneId::Runs) => Some("ZOOM: Runs"),
            ZoomMode::Maximized(PaneId::Graph) => Some("ZOOM: Graph"),
            ZoomMode::Maximized(PaneId::Inspector) => Some("ZOOM: Inspector"),
            ZoomMode::Split if self.sidebar_hidden => Some("Sidebar hidden"),
            ZoomMode::Split => None,
        }
    }

    pub fn compute_body_rects(
        &self,
        body: Rect,
        runs_width: u16,
        inspector_height: u16,
    ) -> BodyRects {
        match self.zoom {
            ZoomMode::Maximized(PaneId::Runs) => BodyRects {
                runs_rect: body,
                main_rect: Rect::default(),
                graph_rect: Rect::default(),
                inspector_rect: Rect::default(),
                sidebar_collapsed: false,
            },
            ZoomMode::Maximized(PaneId::Graph) => BodyRects {
                runs_rect: Rect::default(),
                main_rect: body,
                graph_rect: body,
                inspector_rect: Rect::default(),
                sidebar_collapsed: false,
            },
            ZoomMode::Maximized(PaneId::Inspector) => BodyRects {
                runs_rect: Rect::default(),
                main_rect: body,
                graph_rect: Rect::default(),
                inspector_rect: body,
                sidebar_collapsed: false,
            },
            ZoomMode::Split => {
                let (runs_rect, main_rect, sidebar_collapsed) =
                    if self.sidebar_hidden || runs_width == 0 {
                        (Rect::default(), body, false)
                    } else {
                        let max_sidebar = body.width.saturating_sub(MIN_MAIN_WIDTH);
                        let collapsed =
                            runs_width <= COLLAPSED_SIDEBAR_WIDTH || max_sidebar < MIN_SIDEBAR_WIDTH;
                        let sidebar_width = if collapsed {
                            runs_width.min(COLLAPSED_SIDEBAR_WIDTH).min(max_sidebar)
                        } else {
                            runs_width.clamp(MIN_SIDEBAR_WIDTH, max_sidebar)
                        };

                        if sidebar_width == 0 {
                            (Rect::default(), body, collapsed)
                        } else {
                            let columns = Layout::default()
                                .direction(Direction::Horizontal)
                                .constraints([
                                    Constraint::Length(sidebar_width),
                                    Constraint::Min(0),
                                ])
                                .split(body);
                            (columns[0], columns[1], collapsed)
                        }
                    };

                let total_height = main_rect.height;
                let min_pane = MIN_PANE_HEIGHT.min(total_height / 2);
                let max_inspector = total_height.saturating_sub(min_pane);
                let requested_inspector =
                    i32::from(inspector_height) - i32::from(self.graph_height_delta);
                let resolved_inspector = requested_inspector
                    .clamp(i32::from(min_pane), i32::from(max_inspector))
                    as u16;
                let resolved_graph = total_height.saturating_sub(resolved_inspector);

                let rows = Layout::default()
                    .direction(Direction::Vertical)
                    .constraints([
                        Constraint::Length(resolved_graph),
                        Constraint::Length(resolved_inspector),
                    ])
                    .split(main_rect);

                BodyRects {
                    runs_rect,
                    main_rect,
                    graph_rect: rows[0],
                    inspector_rect: rows[1],
                    sidebar_collapsed,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn classify_zoom_key_maps_expected_bindings() {
        assert_eq!(
            classify_zoom_key(key(KeyCode::Char('m'), KeyModifiers::NONE), ZoomMode::Split),
            Some(ZoomKeyAction::ToggleMaximizeFocused)
        );
        assert_eq!(
            classify_zoom_key(key(KeyCode::Char('M'), KeyModifiers::SHIFT), ZoomMode::Split),
            Some(ZoomKeyAction::ToggleMaximizeFocused)
        );
        assert_eq!(
            classify_zoom_key(
                key(KeyCode::Char('m'), KeyModifiers::CONTROL),
                ZoomMode::Split
            ),
            None
        );

        assert_eq!(
            classify_zoom_key(key(KeyCode::Char('Z'), KeyModifiers::SHIFT), ZoomMode::Split),
            Some(ZoomKeyAction::ToggleMaximizeGraph)
        );
        assert_eq!(
            classify_zoom_key(key(KeyCode::Char('z'), KeyModifiers::NONE), ZoomMode::Split),
            None
        );

        assert_eq!(
            classify_zoom_key(key(KeyCode::Esc, KeyModifiers::NONE), ZoomMode::Split),
            None
        );
        assert_eq!(
            classify_zoom_key(
                key(KeyCode::Esc, KeyModifiers::NONE),
                ZoomMode::Maximized(PaneId::Graph)
            ),
            Some(ZoomKeyAction::RestoreSplit)
        );

        assert_eq!(
            classify_zoom_key(key(KeyCode::Char('j'), KeyModifiers::ALT), ZoomMode::Split),
            Some(ZoomKeyAction::GrowGraph(3))
        );
        assert_eq!(
            classify_zoom_key(key(KeyCode::Down, KeyModifiers::CONTROL), ZoomMode::Split),
            Some(ZoomKeyAction::GrowGraph(3))
        );
        assert_eq!(
            classify_zoom_key(key(KeyCode::Down, KeyModifiers::ALT), ZoomMode::Split),
            Some(ZoomKeyAction::GrowGraph(3))
        );

        assert_eq!(
            classify_zoom_key(key(KeyCode::Char('k'), KeyModifiers::ALT), ZoomMode::Split),
            Some(ZoomKeyAction::ShrinkGraph(3))
        );
        assert_eq!(
            classify_zoom_key(key(KeyCode::Up, KeyModifiers::CONTROL), ZoomMode::Split),
            Some(ZoomKeyAction::ShrinkGraph(3))
        );
        assert_eq!(
            classify_zoom_key(key(KeyCode::Up, KeyModifiers::ALT), ZoomMode::Split),
            Some(ZoomKeyAction::ShrinkGraph(3))
        );

        assert_eq!(
            classify_zoom_key(key(KeyCode::Up, KeyModifiers::NONE), ZoomMode::Split),
            None
        );
    }

    #[test]
    fn apply_action_toggles_maximize_and_restores_split() {
        let mut state = PaneLayoutState::default();
        assert_eq!(state.zoom, ZoomMode::Split);
        assert_eq!(state.status_badge(), None);

        state.apply_action(ZoomKeyAction::ToggleMaximizeFocused, PaneId::Graph);
        assert_eq!(state.zoom, ZoomMode::Maximized(PaneId::Graph));
        assert!(state.status_badge().is_some());

        state.apply_action(ZoomKeyAction::ToggleMaximizeFocused, PaneId::Graph);
        assert_eq!(state.zoom, ZoomMode::Split);

        state.apply_action(ZoomKeyAction::ToggleMaximizeGraph, PaneId::Runs);
        assert_eq!(state.zoom, ZoomMode::Maximized(PaneId::Graph));

        state.apply_action(ZoomKeyAction::RestoreSplit, PaneId::Graph);
        assert_eq!(state.zoom, ZoomMode::Split);
    }

    #[test]
    fn compute_body_rects_maximizes_graph_pane() {
        let mut state = PaneLayoutState::default();
        state.apply_action(ZoomKeyAction::ToggleMaximizeGraph, PaneId::Graph);

        let body = Rect::new(0, 0, 120, 40);
        let rects = state.compute_body_rects(body, 34, 16);

        assert_eq!(rects.graph_rect, body);
        assert_eq!(rects.main_rect, body);
        assert_eq!(rects.runs_rect, Rect::default());
        assert_eq!(rects.inspector_rect, Rect::default());
    }

    #[test]
    fn compute_body_rects_hides_sidebar_when_hidden() {
        let mut state = PaneLayoutState::default();
        state.toggle_sidebar_hidden();
        assert!(state.sidebar_hidden);

        let body = Rect::new(0, 0, 120, 40);
        let rects = state.compute_body_rects(body, 34, 16);

        assert_eq!(rects.runs_rect.width, 0);
        assert_eq!(rects.main_rect.width, body.width);
        assert_eq!(rects.graph_rect.width, body.width);
        assert_eq!(rects.inspector_rect.width, body.width);
    }

    #[test]
    fn compute_body_rects_grows_graph_and_clamps_minimum_heights() {
        let body = Rect::new(0, 0, 120, 40);
        let base = PaneLayoutState::default().compute_body_rects(body, 34, 16);
        assert_eq!(base.graph_rect.height, 24);
        assert_eq!(base.inspector_rect.height, 16);

        let mut grown = PaneLayoutState::default();
        grown.apply_action(ZoomKeyAction::GrowGraph(6), PaneId::Graph);
        let grown_rects = grown.compute_body_rects(body, 34, 16);
        assert_eq!(grown_rects.graph_rect.height, 30);
        assert_eq!(grown_rects.inspector_rect.height, 10);

        let extreme_grow = PaneLayoutState {
            graph_height_delta: 100,
            ..PaneLayoutState::default()
        };
        let extreme_grow_rects = extreme_grow.compute_body_rects(body, 34, 16);
        assert!(extreme_grow_rects.inspector_rect.height >= 8);
        assert!(extreme_grow_rects.graph_rect.height >= 8);
        assert_eq!(
            extreme_grow_rects.graph_rect.height + extreme_grow_rects.inspector_rect.height,
            body.height
        );

        let extreme_shrink = PaneLayoutState {
            graph_height_delta: -100,
            ..PaneLayoutState::default()
        };
        let extreme_shrink_rects = extreme_shrink.compute_body_rects(body, 34, 16);
        assert!(extreme_shrink_rects.inspector_rect.height >= 8);
        assert!(extreme_shrink_rects.graph_rect.height >= 8);
        assert_eq!(
            extreme_shrink_rects.graph_rect.height + extreme_shrink_rects.inspector_rect.height,
            body.height
        );
    }
}
