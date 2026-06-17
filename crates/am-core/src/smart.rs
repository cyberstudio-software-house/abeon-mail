use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SmartFolderKind {
    AllInboxes,
    Unread,
    Flagged,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug)]
pub struct SmartMessageRow {
    pub message_id: i64,
    pub account_id: i64,
    pub folder_id: i64,
    pub account_color: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
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
    fn smart_folder_kind_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&SmartFolderKind::AllInboxes).unwrap(),
            "\"all_inboxes\""
        );
        assert_eq!(
            serde_json::to_string(&SmartFolderKind::Unread).unwrap(),
            "\"unread\""
        );
        assert_eq!(
            serde_json::to_string(&SmartFolderKind::Flagged).unwrap(),
            "\"flagged\""
        );
    }

    #[test]
    fn smart_folder_kind_deserializes_snake_case() {
        let k: SmartFolderKind = serde_json::from_str("\"all_inboxes\"").unwrap();
        assert_eq!(k, SmartFolderKind::AllInboxes);
    }
}
