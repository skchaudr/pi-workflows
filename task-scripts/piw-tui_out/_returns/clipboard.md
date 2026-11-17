```rust
use std::io::{self, Write};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use crate::format::sanitize_text;

const MAX_COPY_BYTES: usize = 100_000;
const NOTICE_MAX_CHARS: usize = 40;

pub fn osc52_sequence(text: &str) -> Result<String, String> {
    if text.is_empty() {
        return Err("cannot copy empty text".to_string());
    }
    if text.len() > MAX_COPY_BYTES {
        return Err(format!(
            "clipboard payload too large ({} bytes, max {})",
            text.len(),
            MAX_COPY_BYTES
        ));
    }

    let encoded = STANDARD.encode(text.as_bytes());
    Ok(format!("\x1b]52;c;{encoded}\x07"))
}

pub fn copy(text: &str) -> Result<(), String> {
    let seq = osc52_sequence(text)?;
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(seq.as_bytes())
        .map_err(|err| format!("failed to write clipboard sequence: {err}"))?;
    stdout
        .flush()
        .map_err(|err| format!("failed to flush clipboard sequence: {err}"))
}

pub fn copied_notice(text: &str) -> String {
    let clean = sanitize_text(text);
    let mut chars = clean.chars();
    let preview: String = chars.by_ref().take(NOTICE_MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("copied {preview}…")
    } else {
        format!("copied {preview}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_exact_osc52_sequence_for_known_string() {
        let seq = osc52_sequence("hello").unwrap();
        assert_eq!(seq, "\x1b]52;c;aGVsbG8=\x07");
    }

    #[test]
    fn rejects_empty_and_oversized_payloads() {
        assert!(osc52_sequence("").is_err());

        let exact_limit = "a".repeat(MAX_COPY_BYTES);
        assert!(osc52_sequence(&exact_limit).is_ok());

        let oversized = "a".repeat(MAX_COPY_BYTES + 1);
        assert!(osc52_sequence(&oversized).is_err());
    }

    #[test]
    fn multi_byte_text_round_trips_through_base64() {
        let original = "λ-run-🚀-日本語-é";
        let seq = osc52_sequence(original).unwrap();
        let encoded = seq
            .strip_prefix("\x1b]52;c;")
            .and_then(|s| s.strip_suffix('\x07'))
            .unwrap();
        let decoded_bytes = STANDARD.decode(encoded).unwrap();
        let decoded = String::from_utf8(decoded_bytes).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn formats_and_shortens_copied_notice() {
        let run_id = "20261115T021043931Z-landing-9197de92";
        assert_eq!(
            copied_notice(run_id),
            "copied 20261115T021043931Z-landing-9197de92"
        );

        let exact_40 = "a".repeat(40);
        assert_eq!(copied_notice(&exact_40), format!("copied {exact_40}"));

        let long = format!("{exact_40}bcd");
        assert_eq!(copied_notice(&long), format!("copied {exact_40}…"));
    }
}
```