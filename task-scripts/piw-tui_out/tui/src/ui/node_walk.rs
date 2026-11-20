use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct WalkEntry {
    pub step_index: usize,
    pub node_id: String,
    pub attempt: usize,
    pub attempts: usize,
}

pub fn entries(node_ids: &[&str]) -> Vec<WalkEntry> {
    let mut totals: HashMap<&str, usize> = HashMap::new();
    for &id in node_ids {
        *totals.entry(id).or_insert(0) += 1;
    }

    let mut seen: HashMap<&str, usize> = HashMap::new();
    node_ids
        .iter()
        .enumerate()
        .map(|(step_index, &id)| {
            let attempt = {
                let count = seen.entry(id).or_insert(0);
                *count += 1;
                *count
            };
            let attempts = totals.get(id).copied().unwrap_or(1);
            WalkEntry {
                step_index,
                node_id: id.to_string(),
                attempt,
                attempts,
            }
        })
        .collect()
}

pub fn locate(entries: &[WalkEntry], node_id: &str, upper: usize) -> Option<usize> {
    entries
        .iter()
        .enumerate()
        .rfind(|(_, entry)| entry.node_id == node_id && entry.step_index <= upper)
        .map(|(idx, _)| idx)
}

pub fn step(len: usize, current: Option<usize>, forward: bool) -> Option<usize> {
    if len == 0 {
        return None;
    }

    match current {
        Some(idx) if idx < len => {
            if forward {
                if idx + 1 < len {
                    Some(idx + 1)
                } else {
                    None
                }
            } else if idx > 0 {
                Some(idx - 1)
            } else {
                None
            }
        }
        _ => {
            if forward {
                Some(0)
            } else {
                Some(len - 1)
            }
        }
    }
}

pub fn attempt_label(entry: &WalkEntry) -> Option<String> {
    if entry.attempts <= 1 {
        None
    } else {
        Some(format!("{} of {}", entry.attempt, entry.attempts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_empty_input() {
        let result = entries(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn entries_with_repeats_tracks_attempts_and_order() {
        let input = ["fetch", "validate", "fetch", "transform", "fetch", "validate"];
        let result = entries(&input);

        assert_eq!(
            result,
            vec![
                WalkEntry {
                    step_index: 0,
                    node_id: "fetch".to_string(),
                    attempt: 1,
                    attempts: 3,
                },
                WalkEntry {
                    step_index: 1,
                    node_id: "validate".to_string(),
                    attempt: 1,
                    attempts: 2,
                },
                WalkEntry {
                    step_index: 2,
                    node_id: "fetch".to_string(),
                    attempt: 2,
                    attempts: 3,
                },
                WalkEntry {
                    step_index: 3,
                    node_id: "transform".to_string(),
                    attempt: 1,
                    attempts: 1,
                },
                WalkEntry {
                    step_index: 4,
                    node_id: "fetch".to_string(),
                    attempt: 3,
                    attempts: 3,
                },
                WalkEntry {
                    step_index: 5,
                    node_id: "validate".to_string(),
                    attempt: 2,
                    attempts: 2,
                },
            ]
        );
    }

    #[test]
    fn locate_finds_latest_entry_up_to_upper() {
        let walk = entries(&["init", "retry", "check", "retry", "done", "retry"]);
        // "retry" is at step_index 1, 3, 5

        // Before first attempt of "retry"
        assert_eq!(locate(&walk, "retry", 0), None);
        // At first attempt
        assert_eq!(locate(&walk, "retry", 1), Some(1));
        // After first, before second
        assert_eq!(locate(&walk, "retry", 2), Some(1));
        // At second attempt
        assert_eq!(locate(&walk, "retry", 3), Some(3));
        // After second, before third
        assert_eq!(locate(&walk, "retry", 4), Some(3));
        // At third attempt
        assert_eq!(locate(&walk, "retry", 5), Some(5));
        // Upper beyond the end
        assert_eq!(locate(&walk, "retry", 100), Some(5));

        // Single-run node
        assert_eq!(locate(&walk, "init", 0), Some(0));
        assert_eq!(locate(&walk, "done", 3), None);
        assert_eq!(locate(&walk, "done", 4), Some(4));
        assert_eq!(locate(&walk, "done", 99), Some(4));

        // Unknown node
        assert_eq!(locate(&walk, "never_ran", 0), None);
        assert_eq!(locate(&walk, "never_ran", 100), None);

        // Empty walk
        assert_eq!(locate(&[], "init", 0), None);
    }

    #[test]
    fn step_navigation_cases() {
        // len 0
        assert_eq!(step(0, None, true), None);
        assert_eq!(step(0, None, false), None);
        assert_eq!(step(0, Some(0), true), None);
        assert_eq!(step(0, Some(0), false), None);

        // len 1
        assert_eq!(step(1, None, true), Some(0));
        assert_eq!(step(1, None, false), Some(0));
        assert_eq!(step(1, Some(0), true), None);
        assert_eq!(step(1, Some(0), false), None);
        assert_eq!(step(1, Some(5), true), Some(0));
        assert_eq!(step(1, Some(5), false), Some(0));

        // len 4: ends and middle
        assert_eq!(step(4, Some(0), false), None);
        assert_eq!(step(4, Some(0), true), Some(1));
        assert_eq!(step(4, Some(1), false), Some(0));
        assert_eq!(step(4, Some(1), true), Some(2));
        assert_eq!(step(4, Some(2), false), Some(1));
        assert_eq!(step(4, Some(2), true), Some(3));
        assert_eq!(step(4, Some(3), false), Some(2));
        assert_eq!(step(4, Some(3), true), None);

        // None current (unexecuted node)
        assert_eq!(step(4, None, true), Some(0));
        assert_eq!(step(4, None, false), Some(3));

        // Out-of-range current
        assert_eq!(step(4, Some(4), true), Some(0));
        assert_eq!(step(4, Some(4), false), Some(3));
        assert_eq!(step(4, Some(99), true), Some(0));
        assert_eq!(step(4, Some(99), false), Some(3));
    }

    #[test]
    fn attempt_label_single_and_repeated() {
        let single = WalkEntry {
            step_index: 0,
            node_id: "once".to_string(),
            attempt: 1,
            attempts: 1,
        };
        assert_eq!(attempt_label(&single), None);

        let repeated_first = WalkEntry {
            step_index: 1,
            node_id: "loop".to_string(),
            attempt: 1,
            attempts: 3,
        };
        assert_eq!(attempt_label(&repeated_first), Some("1 of 3".to_string()));

        let repeated_second = WalkEntry {
            step_index: 2,
            node_id: "loop".to_string(),
            attempt: 2,
            attempts: 3,
        };
        assert_eq!(attempt_label(&repeated_second), Some("2 of 3".to_string()));

        let repeated_third = WalkEntry {
            step_index: 4,
            node_id: "loop".to_string(),
            attempt: 3,
            attempts: 3,
        };
        assert_eq!(attempt_label(&repeated_third), Some("3 of 3".to_string()));
    }
}
