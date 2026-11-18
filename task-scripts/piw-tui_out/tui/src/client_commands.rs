//! Pure protocol helper for tracking and sending state-changing workflow commands.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::protocol::{ClientRequest, ServerResponse, PROTOCOL_ID};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandIds {
    nonce: String,
    counter: u64,
}

impl CommandIds {
    pub fn new() -> Self {
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        Self::with_nonce(&format!("{pid}-{nanos}"))
    }

    pub fn with_nonce(nonce: &str) -> Self {
        Self {
            nonce: nonce.to_string(),
            counter: 0,
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> String {
        self.counter = self.counter.saturating_add(1);
        format!("piwc-{}-{}", self.nonce, self.counter)
    }
}

impl Default for CommandIds {
    fn default() -> Self {
        Self::new()
    }
}

pub fn build_command(ids: &mut CommandIds, operation: &str, run_id: &str) -> ClientRequest {
    let request_id = ids.next();
    let idempotency_key = ids.next();
    let pid = std::process::id();
    ClientRequest {
        schema: PROTOCOL_ID.to_string(),
        message_type: "request".to_string(),
        request_id,
        client_id: format!("piw-{pid}"),
        operation: operation.to_string(),
        idempotency_key,
        run_id: Some(run_id.to_string()),
        expected_revision: None,
        payload: json!({}),
    }
}

pub fn retry_command(ids: &mut CommandIds, original: &ClientRequest) -> ClientRequest {
    let mut retried = original.clone();
    retried.request_id = ids.next();
    retried
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    pub outcome: String,
    pub error: Option<String>,
}

impl CommandOutcome {
    pub fn from_response(response: &ServerResponse) -> Self {
        Self {
            outcome: response.outcome.clone(),
            error: response.error.clone(),
        }
    }

    pub fn is_success(&self) -> bool {
        matches!(self.outcome.as_str(), "accepted" | "adopted")
    }
}

#[derive(Debug, Clone)]
struct TrackedCommand {
    request: ClientRequest,
    sent_on_current_connection: bool,
    ever_sent: bool,
}

#[derive(Debug, Clone, Default)]
pub struct CommandTracker {
    entries: Vec<TrackedCommand>,
}

impl CommandTracker {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn track(&mut self, request: ClientRequest) {
        self.entries.push(TrackedCommand {
            request,
            sent_on_current_connection: false,
            ever_sent: false,
        });
    }

    pub fn take_unsent(&mut self, ids: &mut CommandIds) -> Vec<ClientRequest> {
        let mut unsent = Vec::new();
        for entry in &mut self.entries {
            if !entry.sent_on_current_connection {
                if entry.ever_sent {
                    entry.request = retry_command(ids, &entry.request);
                }
                entry.sent_on_current_connection = true;
                entry.ever_sent = true;
                unsent.push(entry.request.clone());
            }
        }
        unsent
    }

    pub fn connection_lost(&mut self) {
        for entry in &mut self.entries {
            entry.sent_on_current_connection = false;
        }
    }

    pub fn owns(&self, request_id: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.request.request_id == request_id)
    }

    pub fn complete(
        &mut self,
        request_id: &str,
        outcome: CommandOutcome,
    ) -> Option<(ClientRequest, CommandOutcome)> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.request.request_id == request_id)?;
        let entry = self.entries.remove(index);
        Some((entry.request, outcome))
    }

    pub fn is_pending(&self, run_id: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.request.run_id.as_deref() == Some(run_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::encode_request;

    #[test]
    fn build_command_uses_distinct_request_id_and_idempotency_key() {
        let mut ids = CommandIds::with_nonce("test-100");
        let cmd1 = build_command(&mut ids, "run.pause", "run-1");
        let cmd2 = build_command(&mut ids, "run.resume", "run-1");

        assert_eq!(cmd1.schema, PROTOCOL_ID);
        assert_eq!(cmd1.message_type, "request");
        assert_eq!(cmd1.operation, "run.pause");
        assert_eq!(cmd1.run_id.as_deref(), Some("run-1"));
        assert_eq!(cmd1.expected_revision, None);
        assert_eq!(cmd1.payload, json!({}));
        assert!(cmd1.client_id.starts_with("piw-"));

        assert_eq!(cmd1.request_id, "piwc-test-100-1");
        assert_eq!(cmd1.idempotency_key, "piwc-test-100-2");
        assert_ne!(cmd1.request_id, cmd1.idempotency_key);

        assert_eq!(cmd2.request_id, "piwc-test-100-3");
        assert_eq!(cmd2.idempotency_key, "piwc-test-100-4");
        assert_ne!(cmd1.request_id, cmd2.request_id);
        assert_ne!(cmd1.idempotency_key, cmd2.idempotency_key);
        assert_ne!(cmd1.request_id, cmd2.idempotency_key);
        assert_ne!(cmd1.idempotency_key, cmd2.request_id);

        assert!(encode_request(&cmd1).is_ok());
    }

    #[test]
    fn command_ids_with_different_nonces_never_collide() {
        let mut ids_a = CommandIds::with_nonce("100-1000");
        let mut ids_b = CommandIds::with_nonce("100-2000");

        for _ in 0..10 {
            assert_ne!(ids_a.next(), ids_b.next());
        }
    }

    #[test]
    fn retry_command_preserves_key_and_changes_request_id() {
        let mut ids = CommandIds::with_nonce("retry-nonce");
        let original = build_command(&mut ids, "run.cancel", "run-42");
        let retried = retry_command(&mut ids, &original);

        assert_ne!(retried.request_id, original.request_id);
        assert_eq!(retried.idempotency_key, original.idempotency_key);
        assert_eq!(retried.operation, original.operation);
        assert_eq!(retried.run_id, original.run_id);
        assert_eq!(retried.payload, original.payload);
        assert_eq!(retried.client_id, original.client_id);
        assert_eq!(retried.schema, original.schema);
        assert_eq!(retried.message_type, original.message_type);
        assert_eq!(retried.expected_revision, original.expected_revision);
    }

    #[test]
    fn command_outcome_classifies_responses() {
        let accepted = ServerResponse {
            schema: PROTOCOL_ID.to_string(),
            message_type: "response".to_string(),
            request_id: "piwc-1-1".to_string(),
            outcome: "accepted".to_string(),
            revision: Some(3),
            receipt: Some(json!({"ok": true})),
            error: None,
        };
        let outcome = CommandOutcome::from_response(&accepted);
        assert!(outcome.is_success());
        assert_eq!(outcome.outcome, "accepted");
        assert_eq!(outcome.error, None);

        let adopted = ServerResponse {
            outcome: "adopted".to_string(),
            ..accepted.clone()
        };
        assert!(CommandOutcome::from_response(&adopted).is_success());

        let rejected = ServerResponse {
            schema: PROTOCOL_ID.to_string(),
            message_type: "response".to_string(),
            request_id: "piwc-1-1".to_string(),
            outcome: "rejected".to_string(),
            revision: None,
            receipt: None,
            error: Some("run cannot be paused".to_string()),
        };
        let rejected_outcome = CommandOutcome::from_response(&rejected);
        assert!(!rejected_outcome.is_success());
        assert_eq!(rejected_outcome.outcome, "rejected");
        assert_eq!(
            rejected_outcome.error.as_deref(),
            Some("run cannot be paused")
        );
    }

    #[test]
    fn tracker_sends_once_per_connection_retries_with_new_request_id_and_completes() {
        let mut ids = CommandIds::with_nonce("tracker");
        let mut tracker = CommandTracker::new();

        let cmd = build_command(&mut ids, "run.pause", "run-99");
        let first_request_id = cmd.request_id.clone();
        let original_key = cmd.idempotency_key.clone();

        tracker.track(cmd);
        assert!(tracker.is_pending("run-99"));
        assert!(!tracker.is_pending("run-other"));
        assert!(tracker.owns(&first_request_id));

        let batch1 = tracker.take_unsent(&mut ids);
        assert_eq!(batch1.len(), 1);
        assert_eq!(batch1[0].request_id, first_request_id);
        assert_eq!(batch1[0].idempotency_key, original_key);

        let batch2 = tracker.take_unsent(&mut ids);
        assert!(batch2.is_empty());

        tracker.connection_lost();
        let batch3 = tracker.take_unsent(&mut ids);
        assert_eq!(batch3.len(), 1);
        let second_request_id = batch3[0].request_id.clone();
        assert_ne!(second_request_id, first_request_id);
        assert_eq!(batch3[0].idempotency_key, original_key);

        assert!(!tracker.owns(&first_request_id));
        assert!(tracker.owns(&second_request_id));
        assert!(tracker
            .complete(
                &first_request_id,
                CommandOutcome {
                    outcome: "accepted".to_string(),
                    error: None,
                },
            )
            .is_none());

        let completed = tracker.complete(
            &second_request_id,
            CommandOutcome {
                outcome: "accepted".to_string(),
                error: None,
            },
        );
        assert!(completed.is_some());
        let (completed_req, completed_outcome) = completed.unwrap();
        assert_eq!(completed_req.request_id, second_request_id);
        assert_eq!(completed_req.idempotency_key, original_key);
        assert!(completed_outcome.is_success());

        assert!(!tracker.owns(&second_request_id));
        assert!(!tracker.is_pending("run-99"));
    }
}
