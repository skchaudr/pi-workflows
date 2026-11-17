use std::io::ErrorKind;
use std::path::{Component, Path};
use std::process::Command;

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct TraceRecord {
    pub id: String,
    pub status: String,
    pub model: String,
    pub title: String,
    pub path: String,
}

#[derive(Deserialize)]
struct RawTraceRecord {
    id: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    title: Option<String>,
    path: String,
}

pub fn session_from_binding(binding: &Value) -> Option<(Option<String>, String)> {
    let session_id = binding
        .get("piSessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_string();

    let session_file = binding
        .get("piSessionFile")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from);

    Some((session_file, session_id))
}

pub fn parse_list(jsonl: &str) -> Vec<TraceRecord> {
    jsonl
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let raw: RawTraceRecord = serde_json::from_str(line).ok()?;
            if raw.id.is_empty() || raw.path.is_empty() {
                return None;
            }
            Some(TraceRecord {
                id: raw.id,
                status: raw.status.unwrap_or_default(),
                model: raw.model.unwrap_or_default(),
                title: raw.title.unwrap_or_default(),
                path: raw.path,
            })
        })
        .collect()
}

fn has_path_component(path: &str, target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    Path::new(path).components().any(|comp| match comp {
        Component::Normal(os_str) => os_str.to_str() == Some(target),
        _ => false,
    })
}

pub fn matches_for_session(
    records: Vec<TraceRecord>,
    session_file: Option<&str>,
    session_id: &str,
) -> Vec<TraceRecord> {
    let session_file = session_file.filter(|s| !s.is_empty());
    let mut exact = Vec::new();
    let mut component = Vec::new();

    for record in records {
        if let Some(file) = session_file {
            if record.path == file {
                exact.push(record);
                continue;
            }
        }
        if has_path_component(&record.path, session_id) {
            component.push(record);
        }
    }

    exact.extend(component);
    exact
}

pub fn list_traces() -> Result<Vec<TraceRecord>, String> {
    let output = Command::new("grok-traces")
        .args(["list", "--json", "--limit", "5000"])
        .output()
        .map_err(|err| {
            if err.kind() == ErrorKind::NotFound {
                "grok-traces is not on PATH".to_string()
            } else {
                format!("failed to run grok-traces: {err}")
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first_line = stderr
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("grok-traces failed with non-zero exit status");
        return Err(first_line.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_list(&stdout))
}

pub fn traces_for_binding(binding: Option<&Value>) -> Result<Vec<TraceRecord>, String> {
    let binding = binding.ok_or_else(|| "run has no bound Pi session".to_string())?;
    let (session_file, session_id) =
        session_from_binding(binding).ok_or_else(|| "run has no bound Pi session".to_string())?;
    let records = list_traces()?;
    Ok(matches_for_session(
        records,
        session_file.as_deref(),
        &session_id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_list_handles_good_malformed_and_null_fields() {
        let jsonl = concat!(
            r#"{"id":"pi:1","source":"pi","title":"block:abc","model":"gemini-3.8-flash-high","path":"/a/b.jsonl","status":"active","parent_id":null}"#,
            "\n",
            r#"not valid json at all"#,
            "\n",
            r#"{"id":"pi:missing-path","status":"idle"}"#,
            "\n",
            r#"{"id":"pi:2","title":null,"model":null,"path":"/c/d.jsonl","status":"idle"}"#,
            "\n",
            r#"{"id":"pi:3","path":"/e/f.jsonl","status":"completed"}"#,
            "\n"
        );

        let records = parse_list(jsonl);
        assert_eq!(
            records,
            vec![
                TraceRecord {
                    id: "pi:1".to_string(),
                    status: "active".to_string(),
                    model: "gemini-3.8-flash-high".to_string(),
                    title: "block:abc".to_string(),
                    path: "/a/b.jsonl".to_string(),
                },
                TraceRecord {
                    id: "pi:2".to_string(),
                    status: "idle".to_string(),
                    model: "".to_string(),
                    title: "".to_string(),
                    path: "/c/d.jsonl".to_string(),
                },
                TraceRecord {
                    id: "pi:3".to_string(),
                    status: "completed".to_string(),
                    model: "".to_string(),
                    title: "".to_string(),
                    path: "/e/f.jsonl".to_string(),
                },
            ]
        );
    }

    #[test]
    fn exact_match_ordered_first_and_subagent_component_matches() {
        let session_id = "01a1da96-b866-7737-8cc0-7880da63a060";
        let session_file = "/Users/sab-mini/.pi/agent/sessions/--Volumes-Mini-SSD-offload-repos-grok-build--/2026-11-14T15-04-33-126Z_01a1da96-b866-7737-8cc0-7880da63a060.jsonl";

        let records = vec![
            TraceRecord {
                id: "pi:sub1".to_string(),
                status: "idle".to_string(),
                model: "m1".to_string(),
                title: "t1".to_string(),
                path: format!("/tmp/rex-adapter/{session_id}/280c2339-1bda/session.jsonl"),
            },
            TraceRecord {
                id: "pi:unrelated".to_string(),
                status: "active".to_string(),
                model: "m2".to_string(),
                title: "t2".to_string(),
                path: "/tmp/rex-adapter/other-session/session.jsonl".to_string(),
            },
            TraceRecord {
                id: "pi:main".to_string(),
                status: "active".to_string(),
                model: "m3".to_string(),
                title: "t3".to_string(),
                path: session_file.to_string(),
            },
            TraceRecord {
                id: "pi:sub2".to_string(),
                status: "completed".to_string(),
                model: "m4".to_string(),
                title: "t4".to_string(),
                path: format!("/tmp/rex-adapter/{session_id}/99999999-1bda/session.jsonl"),
            },
        ];

        let matched = matches_for_session(records, Some(session_file), session_id);
        let ids: Vec<&str> = matched.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["pi:main", "pi:sub1", "pi:sub2"]);
    }

    #[test]
    fn substring_false_positive_does_not_match() {
        let short_session_id = "01a1da96-b866";
        let records = vec![
            TraceRecord {
                id: "pi:longer-component".to_string(),
                status: "active".to_string(),
                model: "".to_string(),
                title: "".to_string(),
                path: "/tmp/rex-adapter/01a1da96-b866-7737-8cc0-7880da63a060/sub/session.jsonl"
                    .to_string(),
            },
            TraceRecord {
                id: "pi:filename-substring".to_string(),
                status: "active".to_string(),
                model: "".to_string(),
                title: "".to_string(),
                path: "/Users/sab-mini/.pi/agent/sessions/2026-11-14T15-04-33-126Z_01a1da96-b866.jsonl"
                    .to_string(),
            },
        ];

        let matched = matches_for_session(records, None, short_session_id);
        assert!(matched.is_empty());
    }

    #[test]
    fn binding_without_pi_session_file_matches_by_component() {
        let session_id = "01a1da96-b866-7737-8cc0-7880da63a060";
        let binding = json!({
            "schema": "pi-workflows.session-binding.v1",
            "runId": "2026-run",
            "piSessionId": session_id
        });

        let (file, id) = session_from_binding(&binding).expect("valid binding");
        assert_eq!(file, None);
        assert_eq!(id, session_id);

        let binding_null_file = json!({
            "piSessionId": session_id,
            "piSessionFile": null
        });
        assert_eq!(
            session_from_binding(&binding_null_file),
            Some((None, session_id.to_string()))
        );

        let binding_empty_file = json!({
            "piSessionId": session_id,
            "piSessionFile": ""
        });
        assert_eq!(
            session_from_binding(&binding_empty_file),
            Some((None, session_id.to_string()))
        );

        let records = vec![TraceRecord {
            id: "pi:sub".to_string(),
            status: "active".to_string(),
            model: "".to_string(),
            title: "".to_string(),
            path: format!("/var/traces/{session_id}/child/session.jsonl"),
        }];

        let matched = matches_for_session(records, file.as_deref(), &id);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].id, "pi:sub");
    }

    #[test]
    fn binding_without_pi_session_id_returns_none_and_err() {
        let missing_id = json!({
            "schema": "pi-workflows.session-binding.v1",
            "piSessionFile": "/tmp/file.jsonl"
        });
        assert_eq!(session_from_binding(&missing_id), None);

        let empty_id = json!({
            "piSessionId": "",
            "piSessionFile": "/tmp/file.jsonl"
        });
        assert_eq!(session_from_binding(&empty_id), None);

        assert_eq!(
            traces_for_binding(None),
            Err("run has no bound Pi session".to_string())
        );
        assert_eq!(
            traces_for_binding(Some(&missing_id)),
            Err("run has no bound Pi session".to_string())
        );
    }

    #[test]
    fn empty_result_when_nothing_matches() {
        let records = vec![TraceRecord {
            id: "pi:other".to_string(),
            status: "idle".to_string(),
            model: "m".to_string(),
            title: "t".to_string(),
            path: "/tmp/other/path.jsonl".to_string(),
        }];

        let matched = matches_for_session(
            records,
            Some("/tmp/nonexistent/main.jsonl"),
            "01a1da96-b866-7737-8cc0-7880da63a060",
        );
        assert!(matched.is_empty());
    }
}
