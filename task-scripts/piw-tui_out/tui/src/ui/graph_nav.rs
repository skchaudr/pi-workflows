use crate::render::NodeBounds;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Left,
    Right,
    Up,
    Down,
}

fn reading_key(node: &NodeBounds) -> (i64, i64, &str) {
    (node.y, node.x, node.node_id.as_str())
}

fn center_2x(node: &NodeBounds) -> (i64, i64) {
    (
        node.x.saturating_mul(2).saturating_add(node.width),
        node.y.saturating_mul(2).saturating_add(node.height),
    )
}

pub fn first(nodes: &[NodeBounds]) -> Option<String> {
    nodes
        .iter()
        .min_by(|a, b| reading_key(a).cmp(&reading_key(b)))
        .map(|n| n.node_id.clone())
}

pub fn cycle(nodes: &[NodeBounds], current: Option<&str>, forward: bool) -> Option<String> {
    if nodes.is_empty() {
        return None;
    }

    let mut sorted: Vec<&NodeBounds> = nodes.iter().collect();
    sorted.sort_by(|a, b| reading_key(a).cmp(&reading_key(b)));

    if let Some(curr_id) = current {
        if let Some(idx) = sorted.iter().position(|n| n.node_id == curr_id) {
            let next_idx = if forward {
                (idx + 1) % sorted.len()
            } else {
                (idx + sorted.len() - 1) % sorted.len()
            };
            return Some(sorted[next_idx].node_id.clone());
        }
    }

    if forward {
        Some(sorted[0].node_id.clone())
    } else {
        Some(sorted[sorted.len() - 1].node_id.clone())
    }
}

pub fn neighbour(
    nodes: &[NodeBounds],
    current: Option<&str>,
    direction: Direction,
) -> Option<String> {
    let curr_id = match current {
        Some(id) => id,
        None => return first(nodes),
    };

    let curr_node = match nodes.iter().find(|n| n.node_id == curr_id) {
        Some(node) => node,
        None => return first(nodes),
    };

    let (cx, cy) = center_2x(curr_node);

    nodes
        .iter()
        .filter(|n| n.node_id != curr_id)
        .filter_map(|cand| {
            let (nx, ny) = center_2x(cand);
            let (along, across) = match direction {
                Direction::Left => (cx.saturating_sub(nx), (ny.saturating_sub(cy)).abs()),
                Direction::Right => (nx.saturating_sub(cx), (ny.saturating_sub(cy)).abs()),
                Direction::Up => (cy.saturating_sub(ny), (nx.saturating_sub(cx)).abs()),
                Direction::Down => (ny.saturating_sub(cy), (nx.saturating_sub(cx)).abs()),
            };

            if along > 0 {
                let score = along.saturating_add(across.saturating_mul(2));
                Some((score, reading_key(cand), &cand.node_id))
            } else {
                None
            }
        })
        .min_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)))
        .map(|(_, _, id)| id.clone())
}

pub fn reveal_offset(
    node: &NodeBounds,
    offset: (i64, i64),
    viewport: (usize, usize),
    margin: i64,
) -> (i64, i64) {
    let vw = i64::try_from(viewport.0).unwrap_or(i64::MAX);
    let vh = i64::try_from(viewport.1).unwrap_or(i64::MAX);

    let ox = reveal_axis(node.x, node.width, offset.0, vw, margin);
    let oy = reveal_axis(node.y, node.height, offset.1, vh, margin);
    (ox, oy)
}

fn reveal_axis(pos: i64, size: i64, offset: i64, view_size: i64, margin: i64) -> i64 {
    let req_start = pos.saturating_sub(margin);
    let req_end = pos.saturating_add(size).saturating_add(margin);
    let req_span = req_end.saturating_sub(req_start);

    if req_span > view_size {
        return req_start;
    }

    if req_start < offset {
        req_start
    } else if req_end > offset.saturating_add(view_size) {
        req_end.saturating_sub(view_size)
    } else {
        offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, x: i64, y: i64, width: i64, height: i64) -> NodeBounds {
        NodeBounds {
            node_id: id.to_string(),
            x,
            y,
            width,
            height,
        }
    }

    fn grid_3x3() -> Vec<NodeBounds> {
        vec![
            node("tl", 0, 0, 10, 4),
            node("tc", 20, 0, 10, 4),
            node("tr", 40, 0, 10, 4),
            node("ml", 0, 10, 10, 4),
            node("mc", 20, 10, 10, 4),
            node("mr", 40, 10, 10, 4),
            node("bl", 0, 20, 10, 4),
            node("bc", 20, 20, 10, 4),
            node("br", 40, 20, 10, 4),
        ]
    }

    #[test]
    fn grid_from_centre_and_corners() {
        let g = grid_3x3();

        assert_eq!(
            neighbour(&g, Some("mc"), Direction::Left),
            Some("ml".to_string())
        );
        assert_eq!(
            neighbour(&g, Some("mc"), Direction::Right),
            Some("mr".to_string())
        );
        assert_eq!(
            neighbour(&g, Some("mc"), Direction::Up),
            Some("tc".to_string())
        );
        assert_eq!(
            neighbour(&g, Some("mc"), Direction::Down),
            Some("bc".to_string())
        );

        assert_eq!(neighbour(&g, Some("tl"), Direction::Left), None);
        assert_eq!(neighbour(&g, Some("tl"), Direction::Up), None);
        assert_eq!(
            neighbour(&g, Some("tl"), Direction::Right),
            Some("tc".to_string())
        );
        assert_eq!(
            neighbour(&g, Some("tl"), Direction::Down),
            Some("ml".to_string())
        );

        assert_eq!(neighbour(&g, Some("br"), Direction::Right), None);
        assert_eq!(neighbour(&g, Some("br"), Direction::Down), None);
        assert_eq!(
            neighbour(&g, Some("br"), Direction::Left),
            Some("bc".to_string())
        );
        assert_eq!(
            neighbour(&g, Some("br"), Direction::Up),
            Some("mr".to_string())
        );
    }

    #[test]
    fn off_axis_vs_far_on_axis_scoring() {
        let origin = node("origin", 0, 10, 10, 4);
        let near_off = node("near_off", 10, 13, 10, 4); // dx=10, dy=3 -> score_2x = 20 + 2*6 = 32
        let far_on_win = node("far_on", 15, 10, 10, 4); // dx=15, dy=0 -> score_2x = 30
        let far_on_lose = node("very_far_on", 20, 10, 10, 4); // dx=20, dy=0 -> score_2x = 40

        let nodes1 = vec![origin.clone(), near_off.clone(), far_on_lose];
        assert_eq!(
            neighbour(&nodes1, Some("origin"), Direction::Right),
            Some("near_off".to_string())
        );

        let nodes2 = vec![origin, near_off, far_on_win];
        assert_eq!(
            neighbour(&nodes2, Some("origin"), Direction::Right),
            Some("far_on".to_string())
        );
    }

    #[test]
    fn neighbour_tie_break_order() {
        let origin = node("o", 0, 10, 10, 4);
        // Symmetric above and below: both have dx=20, dy=4 -> equal score
        let lower = node("lower", 20, 14, 10, 4);
        let upper = node("upper", 20, 6, 10, 4);
        let nodes = vec![origin.clone(), lower, upper];
        // Upper has smaller y, so it wins tie-break
        assert_eq!(
            neighbour(&nodes, Some("o"), Direction::Right),
            Some("upper".to_string())
        );

        // Same position (y and x equal), break tie by node_id
        let b = node("b_node", 20, 10, 10, 4);
        let a = node("a_node", 20, 10, 10, 4);
        let nodes_id_tie = vec![origin, b, a];
        assert_eq!(
            neighbour(&nodes_id_tie, Some("o"), Direction::Right),
            Some("a_node".to_string())
        );
    }

    #[test]
    fn cycle_forward_and_backward_with_wrap() {
        let nodes = vec![
            node("c", 20, 10, 5, 2),
            node("a", 0, 0, 5, 2),
            node("b", 10, 0, 5, 2),
            node("d", 0, 10, 5, 2),
        ];
        // Reading order: a (0,0), b (10,0), d (0,10), c (20,10)
        assert_eq!(first(&nodes), Some("a".to_string()));

        assert_eq!(cycle(&nodes, Some("a"), true), Some("b".to_string()));
        assert_eq!(cycle(&nodes, Some("b"), true), Some("d".to_string()));
        assert_eq!(cycle(&nodes, Some("d"), true), Some("c".to_string()));
        assert_eq!(cycle(&nodes, Some("c"), true), Some("a".to_string()));

        assert_eq!(cycle(&nodes, Some("a"), false), Some("c".to_string()));
        assert_eq!(cycle(&nodes, Some("c"), false), Some("d".to_string()));
        assert_eq!(cycle(&nodes, Some("d"), false), Some("b".to_string()));
        assert_eq!(cycle(&nodes, Some("b"), false), Some("a".to_string()));
    }

    #[test]
    fn cycle_and_neighbour_with_unknown_or_none_current() {
        let g = grid_3x3();
        assert_eq!(neighbour(&g, None, Direction::Right), Some("tl".to_string()));
        assert_eq!(
            neighbour(&g, Some("missing"), Direction::Down),
            Some("tl".to_string())
        );

        assert_eq!(cycle(&g, None, true), Some("tl".to_string()));
        assert_eq!(cycle(&g, Some("missing"), true), Some("tl".to_string()));
        assert_eq!(cycle(&g, None, false), Some("br".to_string()));
        assert_eq!(cycle(&g, Some("missing"), false), Some("br".to_string()));
    }

    #[test]
    fn empty_slice() {
        let empty: Vec<NodeBounds> = vec![];
        assert_eq!(first(&empty), None);
        assert_eq!(cycle(&empty, None, true), None);
        assert_eq!(cycle(&empty, Some("a"), false), None);
        assert_eq!(neighbour(&empty, None, Direction::Up), None);
        assert_eq!(neighbour(&empty, Some("a"), Direction::Down), None);
    }

    #[test]
    fn reveal_offset_cases() {
        let n = node("n", 20, 15, 10, 6);
        let vp = (50, 30);
        let margin = 2;

        // Already visible (requires x in 18..=32, y in 13..=23)
        assert_eq!(reveal_offset(&n, (0, 0), vp, margin), (0, 0));
        assert_eq!(reveal_offset(&n, (18, 13), vp, margin), (18, 13));

        // Off the left edge (offset.x > 18)
        assert_eq!(reveal_offset(&n, (25, 0), vp, margin), (18, 0));

        // Off the right edge (offset.x + 50 < 32 => offset.x < -18)
        assert_eq!(reveal_offset(&n, (-30, 0), vp, margin), (-18, 0));

        // Off the top edge (offset.y > 13)
        assert_eq!(reveal_offset(&n, (0, 20), vp, margin), (0, 13));

        // Off the bottom edge (offset.y + 30 < 23 => offset.y < -7)
        assert_eq!(reveal_offset(&n, (0, -20), vp, margin), (0, -7));

        // Node + margin larger than viewport: align top/left minus margin
        assert_eq!(reveal_offset(&n, (0, 0), (12, 8), margin), (18, 13));

        // Zero-sized viewport: never panics, aligns top/left minus margin
        assert_eq!(reveal_offset(&n, (0, 0), (0, 0), margin), (18, 13));
    }
}
