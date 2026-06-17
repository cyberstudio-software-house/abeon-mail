use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FolderType {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Spam,
    Archive,
    Custom,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Folder {
    pub id: i64,
    pub account_id: i64,
    pub remote_path: String,
    pub name: String,
    pub folder_type: FolderType,
    pub unread_count: i64,
    pub total_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_roundtrips_through_json() {
        let folder = Folder {
            id: 1,
            account_id: 1,
            remote_path: "INBOX".into(),
            name: "Inbox".into(),
            folder_type: FolderType::Inbox,
            unread_count: 0,
            total_count: 5,
        };
        let json = serde_json::to_string(&folder).unwrap();
        let back: Folder = serde_json::from_str(&json).unwrap();
        assert_eq!(folder, back);
    }

    #[test]
    fn folder_type_inbox_serializes_as_snake_case() {
        let json = serde_json::to_string(&FolderType::Inbox).unwrap();
        assert_eq!(json, "\"inbox\"");
    }
}
