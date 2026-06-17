use serde::{Deserialize, Serialize};

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
