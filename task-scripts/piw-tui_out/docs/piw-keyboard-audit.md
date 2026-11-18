# `piw` Viewer Keyboard-Parity Audit

This audit compares every mouse interaction in `tui/src/ui/mod.rs` (`handle_mouse`, lines 1414–1566) against the keyboard bindings in `handle_key` (lines 1157–1292) and `handle_theme_picker_key` (lines 1137–1155), alongside the user documentation in `docs/TUI_VIEWER.md`.

---

## 1. Mouse vs. Keyboard Parity Table

| Action | Mouse (what the handler does) | Key today | Gap? |
| :--- | :--- | :--- | :--- |
| **Theme picker interaction** | `if app.theme_picker.is_some() { handle_theme_picker_mouse(app, mouse); return; }` *(body of `handle_theme_picker_mouse` is not shown in the excerpt; `interaction.md` notes clicking `[✓ Apply]` or `[× Cancel]`)*. | `KeyCode::Char(',') => app.open_theme_picker()`; in `handle_theme_picker_key`: `KeyCode::Up \| KeyCode::Char('k')` (`move_previous()` + `preview_selected_theme()`), `KeyCode::Down \| KeyCode::Char('j')` (`move_next()` + `preview_selected_theme()`), `KeyCode::Enter => app.apply_theme_picker()`, `KeyCode::Esc => app.cancel_theme_picker()`. | **No** (for navigation, preview, apply, cancel; full mouse handler body not shown). |
| **Timeline track scrub / click-to-seek** | `matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left) \| MouseEventKind::Drag(MouseButton::Left)) && contains(app.timeline.track, mouse.column, mouse.row)`: computes `timeline::position_from_column(...)`. If `position.is_none()` calls `app.rejoin_live()`; else sets `app.temporal_replay = position` (with `app.sync_step_to_temporal()`) or `app.replay = position`, and sets `app.playing = false`. | Step/endpoints only: `KeyCode::Char('[') => app.step_back()`, `KeyCode::Char(']') => app.step_forward()`, `KeyCode::Home \| KeyCode::Char('g') => app.move_to_start()`, `KeyCode::End \| KeyCode::Char('G') \| KeyCode::Char('L') => app.rejoin_live()`, and in `Focus::Inspector` (`InspectorTab::Steps`): `Up`/`k` (`step_back()`) and `Down`/`j` (`step_forward()`). | **Partial** — single-step and start/live jumps exist, but there is no direct arbitrary position seek or coarse multi-step scrub across the track. |
| **Timeline action button clicks** | `if mouse.kind == MouseEventKind::Down(MouseButton::Left)` and `app.timeline.hits.iter().find(\|hit\| contains(hit.rect, mouse.column, mouse.row))` -> calls `app.apply_timeline_action(action)` *(the full `TimelineAction` enum variants are not shown in the excerpt)*. | Global replay transport keys: `KeyCode::Char(' ') => app.apply_timeline_action(timeline::TimelineAction::TogglePlayback)`, `KeyCode::Char('[') => app.step_back()`, `KeyCode::Char(']') => app.step_forward()`, `KeyCode::Char('{') => app.slower_playback()`, `KeyCode::Char('}') => app.faster_playback()`, `KeyCode::Home \| KeyCode::Char('g') => app.move_to_start()`, `KeyCode::End \| KeyCode::Char('G') \| KeyCode::Char('L') => app.rejoin_live()`. | **No** (all documented transport actions have global keys). |
| **Inspector tab clicks** | `if mouse.kind == MouseEventKind::Down(MouseButton::Left)` and `app.inspector_tab_hits.iter().find(\|hit\| contains(hit.rect, mouse.column, mouse.row))` -> sets `app.focus = Focus::Inspector; app.select_inspector_tab(tab);`. | Global: `KeyCode::Char('t') => app.select_inspector_tab(app.tab.next())`, `KeyCode::Char('1')` (`Steps`), `KeyCode::Char('2')` (`Trace`), `KeyCode::Char('3')` (`Conversation`), `KeyCode::Char('4')` (`Info`). *(Note: keys do not automatically set `app.focus = Focus::Inspector`, though `KeyCode::Tab` cycles focus).* | **No**. |
| **Graph wheel scroll (vertical pan)** | `MouseEventKind::ScrollUp \| MouseEventKind::ScrollDown` when `contains(app.graph_rect, mouse.column, mouse.row)` -> pans vertically by `delta` (`-3` or `3`): `app.graph_offset = (x, y + delta); app.follow = false;`. | In `Focus::Graph`: `KeyCode::Up \| KeyCode::Char('k')` (`y - 2`) and `KeyCode::Down \| KeyCode::Char('j')` (`y + 2`), setting `app.follow = false`. | **No**. |
| **Runs pane wheel scroll (select run)** | `MouseEventKind::ScrollUp \| MouseEventKind::ScrollDown` when `contains(app.runs_rect, mouse.column, mouse.row)` -> `app.select_run(summaries, delta.signum())` (`-1` or `1`). | In `Focus::Runs`: `KeyCode::Up \| KeyCode::Char('k') => app.select_run(summaries, -1)`, `KeyCode::Down \| KeyCode::Char('j') => app.select_run(summaries, 1)`. | **No**. |
| **Inspector wheel scroll** | `MouseEventKind::ScrollUp \| MouseEventKind::ScrollDown` when `contains(app.inspector_rect, mouse.column, mouse.row)` -> `app.inspector_scroll = (app.inspector_scroll as i64 + delta).max(0) as usize;` (Works in **all** inspector tabs; additionally, `if app.tab == InspectorTab::Conversation { app.conversation_follow = false; }`). | In `Focus::Inspector`: `KeyCode::PageUp` (`saturating_sub(10)`) and `KeyCode::PageDown` (`+= 10`) work in all tabs, and `Up`/`k` & `Down`/`j` scroll 1 line in `InspectorTab::Info`. **However**, neither `PageUp`/`PageDown` nor any fine-scroll key exists for `Steps`/`Trace`/`Conversation`, and `PageUp`/`PageDown` does **not** set `app.conversation_follow = false`. | **Yes** — 1) `PageUp`/`PageDown` in `Conversation` does not clear `app.conversation_follow`; 2) no fine line-by-line scroll (`inspector_scroll`) when `tab` is `Steps`, `Trace`, or `Conversation` (since `Up`/`Down`/`j`/`k` change item selection there). |
| **Sidebar divider drag-resize** | `MouseEventKind::Down(MouseButton::Left)` when `on_sidebar_divider(app, mouse.column, mouse.row)` -> `app.dragging = Some(DragTarget::Sidebar); app.resize_sidebar(mouse.column);`; `Drag(Left)` -> `app.resize_sidebar(mouse.column)`; `Up(Left)` -> `app.persist_layout()`. | None (`KeyCode::Char('b') if app.show_sidebar` only toggles `app.sidebar_collapsed`). | **Yes** — no keyboard way to resize the sidebar or persist its width. |
| **Inspector divider drag-resize** | `MouseEventKind::Down(MouseButton::Left)` when `on_inspector_divider(app, mouse.column, mouse.row)` -> `app.dragging = Some(DragTarget::Inspector); app.resize_inspector(mouse.row);`; `Drag(Left)` -> `app.resize_inspector(mouse.row)`; `Up(Left)` -> `app.persist_layout()`. | None. | **Yes** — no keyboard way to resize the inspector pane height or persist it. |
| **Focus a pane directly by clicking** | `MouseEventKind::Down(MouseButton::Left)` on `app.graph_rect` (`app.focus = Focus::Graph`), `app.runs_rect` (`app.focus = Focus::Runs`), or `app.inspector_rect` (`app.focus = Focus::Inspector`). | `KeyCode::Tab` cycles `Runs -> Graph -> Inspector -> Runs` (or `Graph <-> Inspector` when `!app.show_sidebar`). | **Minor / Partial** — forward cycle exists (`Tab`), though no reverse cycle (`BackTab`) or direct pane focus jump. |
| **Runs list click to select run** | `MouseEventKind::Down(MouseButton::Left)` when `contains(app.runs_rect, mouse.column, mouse.row)` -> computes `index = app.runs_scroll + row` and calls `app.select_run_id(summaries[index].run_id.clone())`. | In `Focus::Runs`: `KeyCode::Up \| KeyCode::Char('k') => app.select_run(summaries, -1)`, `KeyCode::Down \| KeyCode::Char('j') => app.select_run(summaries, 1)`. | **No** (sequential run selection is supported). |
| **Graph drag-pan** | `MouseEventKind::Down(MouseButton::Left)` inside `app.graph_rect` starts `DragTarget::Graph { start_x, start_y, origin_x, origin_y }`; `Drag(Left)` updates `app.graph_offset = (origin_x + dx, origin_y + dy); app.follow = false;`. | In `Focus::Graph`: `Up`/`k` (`y - 2`), `Down`/`j` (`y + 2`), `Left`/`h` (`x - 4`), `Right`/`l` (`x + 4`) with `app.follow = false` (plus `0` to reset to `(0, 0)` and `app.follow = true`). | **No** *(and Shift+arrows is reserved for panning when arrows/`hjkl` move between nodes)*. |
| **Graph node click to select** | `MouseEventKind::Up(MouseButton::Left)` on `Some(DragTarget::Graph { start_x, start_y, .. })` when `moved <= 1 && contains(app.graph_rect, mouse.column, mouse.row)`: locates the node under `(canvas_x, canvas_y)` in `app.graph_nodes` and calls `app.select_graph_node(&node_id)`. | None in `handle_key` today. *(Note: in the Graph pane, `Enter`, plain arrows, and `hjkl` are already reserved for moving between/selecting nodes in upcoming work).* | **Yes** — `handle_key` has no way to navigate `app.graph_nodes` or call `app.select_graph_node(&node_id)`. |

---

## 2. Proposals for Identified Gaps

*(Constrained by currently bound keys in `handle_key.rs.txt` and the reserved set: `/` `a` `p` `x` `o` `e` `y` `?` `n` `N`, plus Graph-pane `Enter`, plain arrows, `hjkl`, and `Shift+arrows`.)*

### Gap A: Graph Node Navigation & Selection (`app.select_graph_node(&node_id)`)
- **Proposed keys:** In `Focus::Graph`, plain arrows (`Up`, `Down`, `Left`, `Right`) / `h` `j` `k` `l` to move between nodes in `app.graph_nodes` (and `Enter` to confirm/activate if selection is two-stage), while moving graph canvas panning (`app.graph_offset`) to `Shift+Up`, `Shift+Down`, `Shift+Left`, `Shift+Right`.
- **Why it is free / fits:** These exact keys are explicitly reserved in the specification for this purpose (`in the Graph pane Enter, plain arrows and hjkl (move between nodes) and Shift+arrows (pan)`).
- **What it does:** Moves node highlight/selection across `app.graph_nodes` spatially or in topological order and invokes `app.select_graph_node(&node_id)`. `Shift+arrows` takes over the existing `app.graph_offset` adjustments `(x ± 4, y ± 2)` with `app.follow = false`.

### Gap B: Sidebar Border Resize (`app.resize_sidebar` + `app.persist_layout`)
- **Proposed keys:** `Alt+Left` / `Alt+Right` (or `Alt+h` / `Alt+l`) globally when `app.show_sidebar && !app.sidebar_collapsed`.
- **Why it is free:** `handle_key` does not match on `KeyModifiers::ALT` anywhere today, and neither `h`/`l` with `ALT` nor `Alt+Left`/`Alt+Right` conflicts with any global key, pane-local key, or reserved character (`/` `a` `p` `x` `o` `e` `y` `?` `n` `N`).
- **What it does:** Decrements or increments the sidebar width (e.g. by 2 columns via `app.resize_sidebar(...)`) and calls `app.persist_layout()`.

### Gap C: Inspector Border Resize (`app.resize_inspector` + `app.persist_layout`)
- **Proposed keys:** `Alt+Up` / `Alt+Down` (or `Alt+k` / `Alt+j`) globally.
- **Why it is free:** No `KeyModifiers::ALT` bindings exist in `handle_key`, and none of the reserved keys use `Alt`.
- **What it does:** Grows or shrinks the inspector pane height (e.g. by 1–2 rows via `app.resize_inspector(...)`) and calls `app.persist_layout()`.

### Gap D: Inspector Fine Scroll & `conversation_follow` Parity
- **Proposed keys:**
  1. Existing `KeyCode::PageUp` and `KeyCode::PageDown` in `Focus::Inspector`.
  2. `Ctrl+Up` / `Ctrl+Down` (or `Ctrl+u` / `Ctrl+d` for half-page, `Ctrl+y` / `Ctrl+e` avoided due to `y`/`e` reservation—use `Ctrl+Up` / `Ctrl+Down`) in `Focus::Inspector`.
- **Why it is free:** `handle_key` only checks `KeyModifiers::CONTROL` for `KeyCode::Char('c')`. `Ctrl+Up` and `Ctrl+Down` are completely unused and do not touch any reserved characters.
- **What it does:**
  1. In `Focus::Inspector`, `Ctrl+Up` and `Ctrl+Down` adjust `app.inspector_scroll` by `saturating_sub(1)` / `+= 1` (or `3` to match the mouse wheel `delta` of `±3`) regardless of which `InspectorTab` is active (solving the inability to line-scroll expanded payloads in `Steps`, `Trace`, and `Conversation` where plain `Up`/`Down`/`j`/`k` move item selection).
  2. In `PageUp`, `PageDown`, `Ctrl+Up`, and `Ctrl+Down`, add:
     ```rust
     if app.tab == InspectorTab::Conversation {
         app.conversation_follow = false;
     }
     ```
     matching the mouse wheel handler at lines 1484–1486.

### Gap E: Reverse Focus Cycling (`Shift+Tab` / ` KeyCode::BackTab`)
- **Proposed key:** `KeyCode::BackTab` (`Shift+Tab`).
- **Why it is free:** Only `KeyCode::Tab` is bound in `handle_key` (line 1173); `KeyCode::BackTab` is unbound and not in the reserved list.
- **What it does:** Cycles focus in reverse (`Focus::Runs -> Focus::Inspector -> Focus::Graph -> Focus::Runs`, or toggles `Graph <-> Inspector` when `!app.show_sidebar`), complementing direct mouse clicks on any of the three panes.

---

## 3. Needs a Design Decision

1. **Arbitrary Timeline Track Scrubbing (`timeline::position_from_column`):**
   - **Why no obvious key exists:** With the mouse, clicking at any X coordinate on `app.timeline.track` jumps directly to that proportional point in the run (`position_from_column`). On a keyboard, `0`–`9` would be the classic percentage-jump keys (`0%`–`90%`), but `1`–`4` are already bound globally to `app.select_inspector_tab(...)` and `0` is bound in `Focus::Graph` to reset `graph_offset`. We need a design decision on whether coarse stepping (e.g. `Shift+[` / `Shift+]` — which are `{` and `}`, already taken by `slower_playback` / `faster_playback` — or `Alt+[` / `Alt+]` to jump ±10% of `item_count`) is sufficient instead of direct percentage jumps.
2. **Pane-Resize Key Discoverability & Granularity (`resize_sidebar` / `resize_inspector`):**
   - **Why no obvious key exists:** Terminal emulators sometimes intercept `Alt+Arrow` or `Ctrl+Arrow` for word navigation, window management, or tmux pane switching, while single-character brackets (`[`, `]`, `{`, `}`, `<`, `>`, `+`, `-`) are already heavily used for replay transport, Info paging, and graph density. A design decision is needed on whether modifier-arrows (`Alt+Arrows`), a dedicated resize mode, or specific punctuation keys should be used.
3. **Unknown Actions Inside `handle_theme_picker_mouse` and `TimelineAction`:**
   - **Why:** The body of `handle_theme_picker_mouse` and the definition of `TimelineAction` / `app.timeline.hits` are not shown in the provided excerpts. If `app.timeline.hits` includes buttons beyond Play/Pause, Step Back/Forward, Speed, Start, and Live, or if `handle_theme_picker_mouse` supports clicking outside the modal to cancel, those would require confirmation against the rest of `tui/src/ui/mod.rs`.

---

## 4. Disagreements Between `docs/TUI_VIEWER.md` (`interaction.md`) and `handle_key.rs.txt`

1. **`End` key behavior on active vs. non-active runs:**
   - **`interaction.md` says:**
     > `- Replay: `[`/`]` previous/next, Space play/pause, Home or `g` to start, End to jump to latest, and `{`/`}` to change speed. Active runs also show Live; `G` and `L` are its keyboard shortcuts.`
   - **`handle_key.rs.txt` actually does (line 1188):**
     ```rust
     KeyCode::End | KeyCode::Char('G') | KeyCode::Char('L') => app.rejoin_live(),
     ```
   - **Disagreement:** The documentation distinguishes `End` ("to jump to latest") from `G` and `L` ("Active runs also show Live; `G` and `L` are its keyboard shortcuts"), whereas in `handle_key` `KeyCode::End`, `KeyCode::Char('G')`, and `KeyCode::Char('L')` are in the exact same match arm and all unconditionally call `app.rejoin_live()`.

2. **Browser (`Runs`) key navigation when the sidebar is hidden vs. focused:**
   - **`interaction.md` says:**
     > `- Focus: Tab cycles Runs → Graph → Inspector.`
     > `- Browser: `b` expands or collapses it.`
   - **`handle_key.rs.txt` actually does (lines 1169–1179):**
     ```rust
     KeyCode::Char('b') if app.show_sidebar => {
         app.sidebar_collapsed = !app.sidebar_collapsed;
         app.sidebar_explicit = true;
     }
     KeyCode::Tab => {
         app.focus = match (app.focus, app.show_sidebar) {
             (Focus::Runs, _) => Focus::Graph,
             (Focus::Graph, _) => Focus::Inspector,
             (Focus::Inspector, true) => Focus::Runs,
             (Focus::Inspector, false) => Focus::Graph,
         };
     }
     ```
   - **Disagreement:**
     1. `Tab` still cycles into `Focus::Runs` even when `app.sidebar_collapsed` is `true` (because the match checks `app.show_sidebar`, not `!app.sidebar_collapsed`).
     2. Conversely, when `app.show_sidebar` is `false`, `b` does nothing and `Tab` skips `Runs` (`Graph -> Inspector -> Graph`), which is undocumented in `interaction.md`.

3. **Inspector tab switching and focus:**
   - **`interaction.md` says:**
     > `Click the full `[symbol Tab]` buttons, or use `t` or `1`–`4`, to change inspector tabs.`
   - **`handle_mouse.rs.txt` vs `handle_key.rs.txt`:**
     - Mouse click (lines 1458–1467):
       ```rust
       app.focus = Focus::Inspector;
       app.select_inspector_tab(tab);
       ```
     - Keyboard `t` / `1`–`4` (lines 1196–1200):
       ```rust
       KeyCode::Char('t') => app.select_inspector_tab(app.tab.next()),
       KeyCode::Char('1') => app.select_inspector_tab(InspectorTab::Steps),
       KeyCode::Char('2') => app.select_inspector_tab(InspectorTab::Trace),
       KeyCode::Char('3') => app.select_inspector_tab(InspectorTab::Conversation),
       KeyCode::Char('4') => app.select_inspector_tab(InspectorTab::Info),
       ```
   - **Disagreement:** Clicking an inspector tab focuses the Inspector pane (`app.focus = Focus::Inspector`), whereas pressing `t` or `1`–`4` changes the active inspector tab **without** moving `app.focus` to `Focus::Inspector` (so subsequent `j`/`k`/`Enter`/`v`/`<`/`>` keys will not control the inspector unless the user also presses `Tab` to focus it).

4. **Inspector `Up`/`Down` (`j`/`k`) behavior is undocumented across tabs:**
   - **`interaction.md` says:**
     > `- Inspector: Enter expands the selected step, trace payload, or conversation entry. In Trace, `v` changes scope. In Info, `<` and `>` load the previous or next settings, follow-up, and current-update pages. Page Up/Down scrolls long content.`
   - **`handle_key.rs.txt` actually does (lines 1236–1262):**
     - In `Focus::Inspector`, `Up`/`k` and `Down`/`j` are bound per-tab:
       - `InspectorTab::Steps`: calls `app.step_back()` / `app.step_forward()`
       - `InspectorTab::Trace`: changes `app.trace_selected` and resets `app.trace_payload_expanded = false`
       - `InspectorTab::Conversation`: changes `app.conversation_selected`, resets `app.conversation_payload_expanded = false`, and sets `app.conversation_follow = false`
       - `InspectorTab::Info`: scrolls `app.inspector_scroll` by 1 line
   - **Disagreement:** `interaction.md` mentions `Up`/`Down` or `j`/`k` for the Browser and Theme picker, and mentions selecting items in the Inspector ("Enter expands the selected step, trace payload, or conversation entry"), but omits that `Up`/`Down` or `j`/`k` are the keys used in `Focus::Inspector` to select steps, trace entries, and conversation entries (or scroll Info).
