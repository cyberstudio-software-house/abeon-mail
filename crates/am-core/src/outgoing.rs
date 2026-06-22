use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    pub blob_ref: String,
    pub content_id: Option<String>,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct SendError {
    pub id: i64,
    pub account_id: i64,
    pub subject: String,
    pub recipient: String,
    pub error: String,
    pub attempts: i64,
    pub permanent: bool,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct DraftSummary {
    pub id: i64,
    pub account_id: i64,
    pub to: Vec<String>,
    pub subject: String,
    pub date: i64,
    pub snippet: String,
    pub has_attachments: bool,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct OutgoingMessage {
    pub from_address: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text_body: String,
    pub html_body: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<OutgoingAttachment>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outgoing_message_roundtrips_through_json() {
        let m = OutgoingMessage {
            from_address: "me@example.com".into(),
            from_name: Some("Me".into()),
            to: vec!["a@x.com".into()],
            cc: vec![],
            bcc: vec!["secret@x.com".into()],
            subject: "Hi".into(),
            text_body: "hello".into(),
            html_body: Some("<p>hello</p>".into()),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: OutgoingMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
