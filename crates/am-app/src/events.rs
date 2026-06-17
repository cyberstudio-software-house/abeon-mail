use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct SyncProgress {
    pub account_id: i64,
    pub folder_id: i64,
    pub fetched: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct NewMessages {
    pub account_id: i64,
    pub folder_id: i64,
    pub count: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct MailboxChanged {
    pub account_id: i64,
    pub folder_id: i64,
}
