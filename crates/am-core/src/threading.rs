const PREFIXES: &[&str] = &["re", "fwd", "fw", "aw", "wg", "sv", "vs", "antw"];

pub fn normalize_subject(subject: &str) -> String {
    let mut current = subject.trim();
    loop {
        let lower = current.to_ascii_lowercase();
        let mut stripped = false;
        for prefix in PREFIXES {
            let with_colon = format!("{prefix}:");
            if lower.starts_with(&with_colon) {
                current = current[with_colon.len()..].trim_start();
                stripped = true;
                break;
            }
        }
        if !stripped {
            break;
        }
    }
    current.trim().to_ascii_lowercase()
}

pub fn parse_reference_ids(in_reply_to: Option<&str>, references_hdr: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(refs) = references_hdr {
        for token in refs.split_whitespace() {
            if token.starts_with('<') && token.ends_with('>') && !out.contains(&token.to_string()) {
                out.push(token.to_string());
            }
        }
    }
    if let Some(irt) = in_reply_to {
        let t = irt.trim();
        if t.starts_with('<') && t.ends_with('>') && !out.contains(&t.to_string()) {
            out.push(t.to_string());
        }
    }
    out
}

pub const SUBJECT_MERGE_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;

pub fn is_reply_or_forward(subject: &str) -> bool {
    normalize_subject(subject) != subject.trim().to_ascii_lowercase()
}

pub fn allow_subject_merge(
    incoming_subject: &str,
    incoming_date: i64,
    candidate_last_date: i64,
    window_secs: i64,
) -> bool {
    is_reply_or_forward(incoming_subject)
        && (incoming_date - candidate_last_date).abs() <= window_secs
}

#[cfg(test)]
mod tests {
    use super::{normalize_subject, parse_reference_ids};

    #[test]
    fn strips_single_reply_prefix() {
        assert_eq!(normalize_subject("Re: Hello"), "hello");
    }

    #[test]
    fn strips_repeated_and_mixed_prefixes() {
        assert_eq!(normalize_subject("Re: Fwd: RE: Project"), "project");
        assert_eq!(normalize_subject("FW: AW: Update"), "update");
    }

    #[test]
    fn keeps_plain_subject() {
        assert_eq!(normalize_subject("  Quarterly Report "), "quarterly report");
    }

    #[test]
    fn empty_after_strip_is_empty() {
        assert_eq!(normalize_subject("Re: "), "");
    }

    #[test]
    fn reference_ids_merge_in_reply_to_and_references() {
        let ids = parse_reference_ids(Some("<a@x>"), Some("<b@y> <c@z>"));
        assert_eq!(ids, vec!["<b@y>".to_string(), "<c@z>".to_string(), "<a@x>".to_string()]);
    }

    #[test]
    fn reference_ids_dedupe() {
        let ids = parse_reference_ids(Some("<a@x>"), Some("<a@x> <b@y>"));
        assert_eq!(ids, vec!["<a@x>".to_string(), "<b@y>".to_string()]);
    }

    #[test]
    fn reference_ids_empty() {
        assert!(parse_reference_ids(None, None).is_empty());
    }

    use super::{is_reply_or_forward, allow_subject_merge, SUBJECT_MERGE_WINDOW_SECS};

    #[test]
    fn fresh_subject_is_not_a_reply() {
        assert!(!is_reply_or_forward("Test"));
        assert!(!is_reply_or_forward("  Quarterly Report "));
    }

    #[test]
    fn reply_and_forward_prefixes_are_detected() {
        assert!(is_reply_or_forward("Re: Test"));
        assert!(is_reply_or_forward("FW: AW: Update"));
    }

    #[test]
    fn fresh_subject_does_not_merge_into_existing_thread() {
        assert!(!allow_subject_merge("Test", 1000, 900, SUBJECT_MERGE_WINDOW_SECS));
    }

    #[test]
    fn reply_merges_within_window() {
        assert!(allow_subject_merge("Re: Test", 1000, 900, SUBJECT_MERGE_WINDOW_SECS));
    }

    #[test]
    fn reply_outside_window_does_not_merge() {
        let day = 24 * 60 * 60;
        assert!(!allow_subject_merge("Re: Test", 100 * day, 0, SUBJECT_MERGE_WINDOW_SECS));
    }
}
