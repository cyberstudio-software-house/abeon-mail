use am_core::message::NewAttachment;
use mail_parser::{Address, MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedMessage {
    pub message_id_hdr: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub date: i64,
    pub text_plain: Option<String>,
    pub text_html: Option<String>,
    pub attachment_names: Vec<String>,
    pub attachments: Vec<NewAttachment>,
    pub snippet: String,
}

fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
}

fn extract_snippet(text_plain: Option<&str>, text_html: Option<&str>) -> String {
    let source = text_plain.unwrap_or_else(|| text_html.unwrap_or(""));
    let stripped = if text_plain.is_none() && text_html.is_some() {
        strip_html_tags(source)
    } else {
        source.to_string()
    };
    let trimmed = stripped.trim();
    if trimmed.chars().count() <= 150 {
        trimmed.to_string()
    } else {
        let end = trimmed
            .char_indices()
            .nth(150)
            .map(|(b, _)| b)
            .unwrap_or(trimmed.len());
        trimmed[..end].to_string()
    }
}

fn addresses(addr: Option<&Address>) -> Vec<String> {
    match addr {
        Some(Address::List(list)) => list
            .iter()
            .filter_map(|a| a.address.as_deref().map(str::to_string))
            .collect(),
        Some(Address::Group(groups)) => groups
            .iter()
            .flat_map(|g| g.addresses.iter())
            .filter_map(|a| a.address.as_deref().map(str::to_string))
            .collect(),
        None => Vec::new(),
    }
}

pub fn parse_message(raw: &[u8]) -> ParsedMessage {
    let parser = MessageParser::default()
        .with_minimal_headers()
        .with_message_ids();

    let Some(msg) = parser.parse(raw) else {
        return ParsedMessage {
            message_id_hdr: None,
            from_address: String::new(),
            from_name: None,
            to: Vec::new(),
            cc: Vec::new(),
            subject: String::new(),
            date: 0,
            text_plain: None,
            text_html: None,
            attachment_names: Vec::new(),
            attachments: Vec::new(),
            snippet: String::new(),
        };
    };

    let message_id_hdr = msg.message_id().map(str::to_string);

    let (from_address, from_name) = match msg.from() {
        Some(Address::List(addrs)) => {
            let addr = addrs.first();
            let address = addr
                .and_then(|a| a.address.as_deref())
                .unwrap_or("")
                .to_string();
            let name = addr
                .and_then(|a| a.name.as_deref())
                .map(str::to_string);
            (address, name)
        }
        Some(Address::Group(groups)) => {
            let addr = groups.first().and_then(|g| g.addresses.first());
            let address = addr
                .and_then(|a| a.address.as_deref())
                .unwrap_or("")
                .to_string();
            let name = addr
                .and_then(|a| a.name.as_deref())
                .map(str::to_string);
            (address, name)
        }
        None => (String::new(), None),
    };

    let to = addresses(msg.to());
    let cc = addresses(msg.cc());
    let subject = msg.subject().unwrap_or("").to_string();
    let date = msg.date().map(|d| d.to_timestamp()).unwrap_or(0);
    let text_plain = msg.body_text(0).map(|s| s.into_owned());
    let text_html = msg.body_html(0).map(|s| s.into_owned());

    let html_lower = text_html
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();

    let attachments: Vec<NewAttachment> = msg
        .attachments()
        .filter(|part| part.sub_parts().is_none())
        .map(|part| {
            let content_id = part
                .content_id()
                .map(|c| c.trim_matches(|ch| ch == '<' || ch == '>').to_string());
            let disposition_attachment = part
                .content_disposition()
                .map(|d| d.is_attachment())
                .unwrap_or(false);
            let referenced_in_html = content_id
                .as_deref()
                .is_some_and(|cid| html_lower.contains(&format!("cid:{}", cid.to_ascii_lowercase())));
            let is_inline = !disposition_attachment && referenced_in_html;
            let mime_type = part
                .content_type()
                .map(|ct| match ct.subtype() {
                    Some(sub) => format!("{}/{}", ct.ctype(), sub),
                    None => ct.ctype().to_string(),
                })
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let content = part.contents().to_vec();
            let size = content.len() as i64;
            let filename = part
                .attachment_name()
                .map(str::to_string)
                .or_else(|| content_id.clone())
                .unwrap_or_else(|| "attachment".to_string());
            NewAttachment {
                filename,
                mime_type,
                size,
                content_id,
                is_inline,
                content,
            }
        })
        .collect();

    let attachment_names: Vec<String> = attachments
        .iter()
        .filter(|a| !a.is_inline)
        .map(|a| a.filename.clone())
        .collect();

    let snippet = extract_snippet(text_plain.as_deref(), text_html.as_deref());

    ParsedMessage {
        message_id_hdr,
        from_address,
        from_name,
        to,
        cc,
        subject,
        date,
        text_plain,
        text_html,
        attachment_names,
        attachments,
        snippet,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MULTIPART_RAW: &[u8] = b"From: Alice Example <alice@example.com>\r\n\
Date: Mon, 1 Jan 2024 12:00:00 +0000\r\n\
Subject: Test Message\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"boundary42\"\r\n\
Message-ID: <testmessage@example.com>\r\n\
\r\n\
--boundary42\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Hello, world! This is the plain text body.\r\n\
--boundary42\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<html><body><p>Hello, world!</p></body></html>\r\n\
--boundary42\r\n\
Content-Type: application/octet-stream\r\n\
Content-Disposition: attachment; filename=\"test.bin\"\r\n\
\r\n\
BINARYDATA\r\n\
--boundary42--\r\n";

    #[test]
    fn test_multipart_parsing() {
        let result = parse_message(MULTIPART_RAW);
        assert_eq!(result.from_address, "alice@example.com");
        assert_eq!(result.subject, "Test Message");
        assert!(result.text_plain.is_some());
        assert!(result.text_html.is_some());
        assert!(!result.attachment_names.is_empty());
        assert!(!result.snippet.is_empty());
        assert_eq!(result.message_id_hdr.as_deref(), Some("testmessage@example.com"));
    }

    #[test]
    fn test_malformed_no_panic() {
        let result = parse_message(b"garbage input not a real email");
        assert_eq!(result.from_address, "");
        assert_eq!(result.subject, "");
    }

    #[test]
    fn test_snippet_length() {
        let result = parse_message(MULTIPART_RAW);
        assert!(result.snippet.chars().count() <= 150);
    }

    #[test]
    fn test_date_extraction() {
        let result = parse_message(MULTIPART_RAW);
        assert!(result.date > 0);
    }

    #[test]
    fn extracts_attachment_bytes_and_metadata() {
        let result = parse_message(MULTIPART_RAW);
        assert_eq!(result.attachments.len(), 1);
        let att = &result.attachments[0];
        assert_eq!(att.filename, "test.bin");
        assert_eq!(att.content, b"BINARYDATA");
        assert_eq!(att.size, 10);
        assert!(!att.is_inline);
    }

    #[test]
    fn inline_image_with_content_id_is_marked_inline() {
        let raw = b"From: a@x.com\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/html\r\n\
\r\n\
<img src=\"cid:logo\">\r\n\
--b\r\n\
Content-Type: image/png\r\n\
Content-ID: <logo>\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--b--\r\n";
        let result = parse_message(raw);
        let inline: Vec<_> = result.attachments.iter().filter(|a| a.is_inline).collect();
        assert_eq!(inline.len(), 1);
        assert_eq!(inline[0].content_id.as_deref(), Some("logo"));
        assert!(result.attachment_names.is_empty());
    }

    #[test]
    fn pdf_with_content_id_and_attachment_disposition_is_not_inline() {
        let raw = b"From: a@x.com\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/html\r\n\
\r\n\
<div>Pozdrawiam</div>\r\n\
--b\r\n\
Content-Type: application/pdf; name=\"Cyber 06.pdf\"\r\n\
Content-ID: <a42db8932a2378d74e98059e861bbfba>\r\n\
Content-Disposition: attachment; filename=\"Cyber 06.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0=\r\n\
--b--\r\n";
        let result = parse_message(raw);
        assert_eq!(result.attachments.len(), 1);
        assert!(!result.attachments[0].is_inline);
        assert_eq!(result.attachment_names, vec!["Cyber 06.pdf".to_string()]);
    }

    #[test]
    fn content_id_without_html_reference_is_not_inline() {
        let raw = b"From: a@x.com\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/html\r\n\
\r\n\
<div>brak osadzonych obrazow</div>\r\n\
--b\r\n\
Content-Type: application/pdf; name=\"cv.pdf\"\r\n\
Content-ID: <orphan-cid>\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0=\r\n\
--b--\r\n";
        let result = parse_message(raw);
        assert_eq!(result.attachments.len(), 1);
        assert!(!result.attachments[0].is_inline);
        assert_eq!(result.attachment_names, vec!["cv.pdf".to_string()]);
    }

    #[test]
    fn inline_disposition_without_content_id_is_listed_as_attachment() {
        let raw = b"From: a@x.com\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/html\r\n\
\r\n\
<p>hi</p>\r\n\
--b\r\n\
Content-Type: application/pdf\r\n\
Content-Disposition: inline; filename=\"contract.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0=\r\n\
--b--\r\n";
        let result = parse_message(raw);
        assert_eq!(result.attachments.len(), 1);
        assert!(!result.attachments[0].is_inline);
        assert_eq!(result.attachment_names, vec!["contract.pdf".to_string()]);
    }

    #[test]
    fn inline_image_referenced_with_uppercase_cid_stays_inline() {
        let raw = b"From: a@x.com\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/html\r\n\
\r\n\
<img src=\"CID:Logo@Example.COM\">\r\n\
--b\r\n\
Content-Type: image/png\r\n\
Content-ID: <logo@example.com>\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--b--\r\n";
        let result = parse_message(raw);
        assert_eq!(result.attachments.len(), 1);
        assert!(result.attachments[0].is_inline);
        assert!(result.attachment_names.is_empty());
    }

    #[test]
    fn parses_to_and_cc_addresses() {
        let raw = b"From: a@x.com\r\nTo: b@y.com, c@z.com\r\nCc: d@w.com\r\nSubject: S\r\n\r\nbody\r\n";
        let parsed = parse_message(raw);
        assert_eq!(parsed.to, vec!["b@y.com".to_string(), "c@z.com".to_string()]);
        assert_eq!(parsed.cc, vec!["d@w.com".to_string()]);
    }
}
