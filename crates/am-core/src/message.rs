use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageFlag {
    Seen,
    Flagged,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct MessageHeader {
    pub id: i64,
    pub account_id: i64,
    pub folder_id: i64,
    pub subject: String,
    pub from_address: String,
    pub from_name: Option<String>,
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    pub snippet: String,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct NewMessageHeader {
    pub uid: i64,
    pub message_id_hdr: Option<String>,
    pub in_reply_to: Option<String>,
    pub references_hdr: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    pub size: i64,
    pub snippet: String,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct MessageBody {
    pub message_id: i64,
    pub text_plain: Option<String>,
    pub text_html: Option<String>,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct SyncProgress {
    pub account_id: i64,
    pub folder_id: i64,
    pub fetched: i64,
    pub total: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_header_roundtrips_through_json() {
        let message = MessageHeader {
            id: 1,
            account_id: 1,
            folder_id: 1,
            subject: "Test Subject".into(),
            from_address: "test@example.com".into(),
            from_name: Some("Test User".into()),
            date: 1234567890,
            seen: false,
            flagged: false,
            has_attachments: false,
            snippet: "Test snippet".into(),
        };
        let json = serde_json::to_string(&message).unwrap();
        let back: MessageHeader = serde_json::from_str(&json).unwrap();
        assert_eq!(message, back);
    }
}
