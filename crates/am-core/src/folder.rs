use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
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
