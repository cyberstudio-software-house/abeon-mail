use am_core::outgoing::OutgoingMessage;
use mail_builder::MessageBuilder;
use mail_builder::headers::address::Address;
use mail_builder::mime::{BodyPart, MimePart};

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

    let (inline_atts, regular_atts): (Vec<_>, Vec<_>) = msg
        .attachments
        .iter()
        .partition(|a| a.content_id.is_some());

    let has_inline = !inline_atts.is_empty();
    let has_regular = !regular_atts.is_empty();
    let has_html = msg.html_body.is_some();

    if !has_inline && !has_regular {
        builder = builder.text_body(msg.text_body.clone());
        if let Some(html) = &msg.html_body {
            let safe = sanitize_html(html);
            builder = builder.html_body(safe.html);
        }
        return builder.write_to_vec().unwrap_or_default();
    }

    if !has_inline {
        builder = builder.text_body(msg.text_body.clone());
        if let Some(html) = &msg.html_body {
            let safe = sanitize_html(html);
            builder = builder.html_body(safe.html);
        }
        for att in &regular_atts {
            let data = std::fs::read(&att.blob_ref).unwrap_or_default();
            builder = builder.attachment(att.mime_type.clone(), att.filename.clone(), data);
        }
        return builder.write_to_vec().unwrap_or_default();
    }

    let text_part = MimePart::new("text/plain", BodyPart::Text(msg.text_body.clone().into()));

    let alternative_parts = if has_html {
        let safe_html = sanitize_html(msg.html_body.as_ref().unwrap());
        let html_part = MimePart::new("text/html", BodyPart::Text(safe_html.html.into()));
        vec![text_part, html_part]
    } else {
        vec![text_part]
    };

    let alternative = if alternative_parts.len() > 1 {
        MimePart::new("multipart/alternative", alternative_parts)
    } else {
        alternative_parts.into_iter().next().unwrap()
    };

    let mut related_parts = vec![alternative];
    for att in &inline_atts {
        let data = std::fs::read(&att.blob_ref).unwrap_or_default();
        let cid = att.content_id.as_ref().unwrap().clone();
        related_parts.push(
            MimePart::new(att.mime_type.clone(), BodyPart::Binary(data.into()))
                .inline()
                .cid(cid),
        );
    }

    let related = MimePart::new("multipart/related", related_parts);

    let body = if has_regular {
        let mut mixed_parts: Vec<MimePart<'_>> = vec![related];
        for att in &regular_atts {
            let data = std::fs::read(&att.blob_ref).unwrap_or_default();
            mixed_parts.push(
                MimePart::new(att.mime_type.clone(), BodyPart::Binary(data.into()))
                    .attachment(att.filename.clone()),
            );
        }
        MimePart::new("multipart/mixed", mixed_parts)
    } else {
        related
    };

    builder.body(body).write_to_vec().unwrap_or_default()
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

    #[test]
    fn inline_image_becomes_related_part_with_content_id() {
        let mut m = base();
        let dir = std::env::temp_dir().join(format!("am-inline-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("img.png");
        std::fs::write(&p, b"PNGDATA").unwrap();
        m.html_body = Some("<p><img src=\"cid:img1\"></p>".into());
        m.attachments.push(OutgoingAttachment {
            filename: "img.png".into(), mime_type: "image/png".into(),
            blob_ref: p.to_string_lossy().into_owned(), content_id: Some("img1".into()),
        });
        let bytes = build_message(&m);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.to_lowercase().contains("multipart/related"));
        assert!(text.contains("img1"));
        let parsed = mail_parser::MessageParser::default().parse(&bytes).unwrap();
        assert!(parsed.body_html(0).is_some());
    }
}
