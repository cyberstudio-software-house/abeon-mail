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
}
