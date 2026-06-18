use am_core::outgoing::OutgoingMessage;
use am_storage::{accounts_repo, messages_repo, Database};
use crate::auth::CredentialSource;
use crate::service::{get_or_fetch_body, get_or_fetch_recipients, SyncError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyMode {
    Reply,
    ReplyAll,
    Forward,
}

pub fn normalize_reply_subject(subject: &str, mode: ReplyMode) -> String {
    let trimmed = subject.trim();
    let prefix = match mode {
        ReplyMode::Forward => "Fwd: ",
        _ => "Re: ",
    };
    let lower = trimmed.to_ascii_lowercase();
    let already = match mode {
        ReplyMode::Forward => lower.starts_with("fwd:") || lower.starts_with("fw:"),
        _ => lower.starts_with("re:"),
    };
    if already {
        trimmed.to_string()
    } else {
        format!("{prefix}{trimmed}")
    }
}

pub fn build_recipients(
    mode: ReplyMode,
    self_addr: &str,
    src_from: &str,
    src_to: &[String],
    src_cc: &[String],
) -> (Vec<String>, Vec<String>) {
    let self_l = self_addr.to_ascii_lowercase();
    let eq = |a: &str| a.to_ascii_lowercase() == self_l;
    match mode {
        ReplyMode::Forward => (Vec::new(), Vec::new()),
        ReplyMode::Reply => (vec![src_from.to_string()], Vec::new()),
        ReplyMode::ReplyAll => {
            let to = vec![src_from.to_string()];
            let mut cc = Vec::new();
            for a in src_to.iter().chain(src_cc.iter()) {
                if !eq(a)
                    && a.to_ascii_lowercase() != src_from.to_ascii_lowercase()
                    && !cc.iter().any(|c: &String| c.eq_ignore_ascii_case(a))
                {
                    cc.push(a.clone());
                }
            }
            (to, cc)
        }
    }
}

pub fn build_references(src_references: &[String], src_message_id: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = src_references.to_vec();
    if let Some(mid) = src_message_id {
        if !out.iter().any(|r| r == mid) {
            out.push(mid.to_string());
        }
    }
    out
}

fn sanitize_original(html: &str) -> String {
    am_mime::sanitize::sanitize_html(html).html
}

fn escape_html_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

pub fn quote_html(original_html: &str, attribution: &str) -> String {
    let safe = sanitize_original(original_html);
    let attribution = escape_html_text(attribution);
    format!("<p>{attribution}</p><blockquote>{safe}</blockquote>")
}

pub fn quote_text(original_text: &str, attribution: &str) -> String {
    let quoted: String = original_text.lines().map(|l| format!("> {l}\n")).collect();
    format!("{attribution}\n{quoted}")
}

pub async fn build_prefill(
    db: &Database,
    message_id: i64,
    mode: ReplyMode,
    creds: &dyn CredentialSource,
) -> Result<(i64, OutgoingMessage), SyncError> {
    let src = messages_repo::get_compose_source(db, message_id)?;
    let account = accounts_repo::get_account(db, src.account_id)?;
    let body = get_or_fetch_body(db, message_id, creds).await?;
    let (src_to, src_cc) = if mode != ReplyMode::Forward {
        get_or_fetch_recipients(db, message_id, creds).await?
    } else {
        (Vec::new(), Vec::new())
    };
    let (to, cc) = build_recipients(mode, &account.email, &src.from_address, &src_to, &src_cc);
    let subject = normalize_reply_subject(&src.subject, mode);
    let references = build_references(
        &src.references_hdr
            .as_deref()
            .map(|s| s.split_whitespace().map(String::from).collect::<Vec<_>>())
            .unwrap_or_default(),
        src.message_id_hdr.as_deref(),
    );
    let attribution = format!(
        "On an earlier date, {} wrote:",
        src.from_name.clone().unwrap_or(src.from_address.clone())
    );
    let html_body = body.text_html.as_deref().map(|h| quote_html(h, &attribution));
    let text_body = quote_text(body.text_plain.as_deref().unwrap_or(""), &attribution);
    Ok((
        src.account_id,
        OutgoingMessage {
            from_address: account.email.clone(),
            from_name: Some(account.display_name.clone()),
            to,
            cc,
            bcc: vec![],
            subject,
            text_body,
            html_body,
            in_reply_to: src.message_id_hdr.clone(),
            references,
            attachments: vec![],
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_subject_adds_re_prefix() {
        assert_eq!(normalize_reply_subject("Hello", ReplyMode::Reply), "Re: Hello");
    }

    #[test]
    fn normalize_subject_no_double_re() {
        assert_eq!(normalize_reply_subject("Re: Hello", ReplyMode::Reply), "Re: Hello");
    }

    #[test]
    fn normalize_subject_adds_fwd_prefix() {
        assert_eq!(normalize_reply_subject("Hello", ReplyMode::Forward), "Fwd: Hello");
    }

    #[test]
    fn normalize_subject_no_double_fwd() {
        assert_eq!(normalize_reply_subject("Fwd: Hello", ReplyMode::Forward), "Fwd: Hello");
    }

    #[test]
    fn normalize_subject_no_double_fw_alias() {
        assert_eq!(normalize_reply_subject("FW: Hello", ReplyMode::Forward), "FW: Hello");
    }

    #[test]
    fn build_recipients_reply_returns_sender() {
        let (to, cc) = build_recipients(
            ReplyMode::Reply,
            "me@example.com",
            "sender@example.com",
            &["me@example.com".to_string()],
            &[],
        );
        assert_eq!(to, vec!["sender@example.com".to_string()]);
        assert!(cc.is_empty());
    }

    #[test]
    fn build_recipients_reply_all_excludes_self_and_sender() {
        let src_to = vec!["me@example.com".to_string(), "other@example.com".to_string()];
        let src_cc = vec!["sender@example.com".to_string(), "another@example.com".to_string()];
        let (to, cc) = build_recipients(
            ReplyMode::ReplyAll,
            "me@example.com",
            "sender@example.com",
            &src_to,
            &src_cc,
        );
        assert_eq!(to, vec!["sender@example.com".to_string()]);
        assert!(!cc.contains(&"me@example.com".to_string()));
        assert!(!cc.contains(&"sender@example.com".to_string()));
        assert!(cc.contains(&"other@example.com".to_string()));
        assert!(cc.contains(&"another@example.com".to_string()));
    }

    #[test]
    fn build_recipients_reply_all_dedupes() {
        let src_to = vec!["dup@example.com".to_string()];
        let src_cc = vec!["dup@example.com".to_string()];
        let (_, cc) = build_recipients(
            ReplyMode::ReplyAll,
            "me@example.com",
            "sender@example.com",
            &src_to,
            &src_cc,
        );
        assert_eq!(cc.iter().filter(|a| a.as_str() == "dup@example.com").count(), 1);
    }

    #[test]
    fn build_recipients_forward_returns_empty() {
        let (to, cc) = build_recipients(
            ReplyMode::Forward,
            "me@example.com",
            "sender@example.com",
            &["other@example.com".to_string()],
            &[],
        );
        assert!(to.is_empty());
        assert!(cc.is_empty());
    }

    #[test]
    fn build_references_appends_message_id() {
        let refs = vec!["<a@x>".to_string(), "<b@y>".to_string()];
        let result = build_references(&refs, Some("<c@z>"));
        assert_eq!(result, vec!["<a@x>".to_string(), "<b@y>".to_string(), "<c@z>".to_string()]);
    }

    #[test]
    fn build_references_no_duplicate() {
        let refs = vec!["<a@x>".to_string()];
        let result = build_references(&refs, Some("<a@x>"));
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn build_references_none_message_id() {
        let refs = vec!["<a@x>".to_string()];
        let result = build_references(&refs, None);
        assert_eq!(result, refs);
    }

    #[test]
    fn quote_html_wraps_in_blockquote() {
        let result = quote_html("<p>hi</p>", "Author wrote:");
        assert!(result.contains("<blockquote>"));
        assert!(result.contains("hi"));
    }

    #[test]
    fn quote_html_strips_script() {
        let result = quote_html("<script>evil()</script><p>hi</p>", "Author wrote:");
        assert!(!result.contains("<script>"));
        assert!(!result.contains("evil()"));
    }

    #[test]
    fn quote_html_escapes_attribution_to_prevent_xss() {
        let out = quote_html("<p>body</p>", "On date, <img src=x onerror=alert(1)> <script>evil</script> wrote:");
        assert!(!out.contains("<img"), "raw img tag leaked from attribution: {out}");
        assert!(!out.contains("<script>"), "raw script tag leaked from attribution: {out}");
        assert!(out.contains("&lt;img"), "attribution should be html-escaped");
    }

    #[test]
    fn quote_text_prefixes_lines() {
        let result = quote_text("line1\nline2", "On date, X wrote:");
        assert!(result.starts_with("On date, X wrote:"));
        assert!(result.contains("> line1"));
        assert!(result.contains("> line2"));
    }
}
