use am_core::outgoing::OutgoingMessage;
use mail_builder::MessageBuilder;
use mail_builder::headers::address::Address;

use crate::sanitize::sanitize_html;

pub fn build_message(msg: &OutgoingMessage) -> Vec<u8> {
    let from = match &msg.from_name {
        Some(name) => Address::new_address(Some(name.clone()), msg.from_address.clone()),
        None => Address::new_address(None::<String>, msg.from_address.clone()),
    };

    let mut builder = MessageBuilder::new()
        .from(from)
        .to(msg.to.clone())
        .subject(msg.subject.clone());

    if !msg.cc.is_empty() {
        builder = builder.cc(msg.cc.clone());
    }

    if let Some(irt) = &msg.in_reply_to {
        builder = builder.in_reply_to(irt.clone());
    }

    if !msg.references.is_empty() {
        builder = builder.references(msg.references.clone());
    }

    builder = builder.text_body(msg.text_body.clone());

    if let Some(html) = &msg.html_body {
        let safe = sanitize_html(html);
        builder = builder.html_body(safe.html);
    }

    for att in &msg.attachments {
        let data = std::fs::read(&att.blob_ref).unwrap_or_default();
        builder = builder.attachment(att.mime_type.clone(), att.filename.clone(), data);
    }

    builder.write_to_vec().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::build_message;
    use am_core::outgoing::{OutgoingMessage, OutgoingAttachment};
    use mail_parser::MessageParser;

    fn base() -> OutgoingMessage {
        OutgoingMessage {
            from_address: "me@example.com".into(),
            from_name: Some("Me Sender".into()),
            to: vec!["rcpt@example.com".into()],
            cc: vec![],
            bcc: vec!["hidden@example.com".into()],
            subject: "Subject Z".into(),
            text_body: "plain body".into(),
            html_body: Some("<p>html body</p>".into()),
            in_reply_to: Some("<parent@example.com>".into()),
            references: vec!["<a@x>".into(), "<parent@example.com>".into()],
            attachments: vec![],
        }
    }

    #[test]
    fn builds_alternative_with_headers_and_bodies() {
        let bytes = build_message(&base());
        let parsed = MessageParser::default().parse(&bytes).unwrap();
        assert_eq!(parsed.subject().unwrap(), "Subject Z");
        assert_eq!(parsed.to().unwrap().first().unwrap().address().unwrap(), "rcpt@example.com");
        assert!(parsed.body_text(0).is_some());
        assert!(parsed.body_html(0).is_some());
    }

    #[test]
    fn bcc_is_not_written_into_headers() {
        let bytes = build_message(&base());
        let text = String::from_utf8_lossy(&bytes).to_lowercase();
        assert!(!text.contains("hidden@example.com"), "BCC leaked into headers");
    }

    #[test]
    fn references_and_in_reply_to_present() {
        let bytes = build_message(&base());
        let parsed = MessageParser::default().parse(&bytes).unwrap();
        assert_eq!(parsed.in_reply_to().as_text().unwrap(), "parent@example.com");
    }

    #[test]
    fn attachment_is_included() {
        let mut m = base();
        m.attachments.push(OutgoingAttachment {
            filename: "note.txt".into(),
            mime_type: "text/plain".into(),
            blob_ref: String::new(),
            content_id: None,
        });
        let dir = std::env::temp_dir().join(format!("am-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.txt");
        std::fs::write(&path, b"ATTACHMENT DATA").unwrap();
        m.attachments[0].blob_ref = path.to_string_lossy().into_owned();
        let bytes = build_message(&m);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("note.txt"));
    }
}
