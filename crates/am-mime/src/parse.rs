use mail_parser::{Address, MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedMessage {
    pub message_id_hdr: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub date: i64,
    pub text_plain: Option<String>,
    pub text_html: Option<String>,
    pub attachment_names: Vec<String>,
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

pub fn parse_message(raw: &[u8]) -> ParsedMessage {
    let parser = MessageParser::default()
        .with_minimal_headers()
        .with_message_ids();

    let Some(msg) = parser.parse(raw) else {
        return ParsedMessage {
            message_id_hdr: None,
            from_address: String::new(),
            from_name: None,
            subject: String::new(),
            date: 0,
            text_plain: None,
            text_html: None,
            attachment_names: Vec::new(),
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

    let subject = msg.subject().unwrap_or("").to_string();
    let date = msg.date().map(|d| d.to_timestamp()).unwrap_or(0);
    let text_plain = msg.body_text(0).map(|s| s.into_owned());
    let text_html = msg.body_html(0).map(|s| s.into_owned());

    let attachment_names: Vec<String> = msg
        .attachments()
        .filter_map(|part| part.attachment_name().map(str::to_string))
        .collect();

    let snippet = extract_snippet(text_plain.as_deref(), text_html.as_deref());

    ParsedMessage {
        message_id_hdr,
        from_address,
        from_name,
        subject,
        date,
        text_plain,
        text_html,
        attachment_names,
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
}
