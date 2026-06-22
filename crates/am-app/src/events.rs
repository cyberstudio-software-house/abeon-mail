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

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct AccountAuthChanged {
    pub account_id: i64,
    pub requires_reauth: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct SnoozeWoke {
    pub count: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct SendFailed {
    pub account_id: i64,
    pub error: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct PrefetchProgress {
    pub account_id: i64,
    pub done: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct SendSucceeded {
    pub account_id: i64,
}
