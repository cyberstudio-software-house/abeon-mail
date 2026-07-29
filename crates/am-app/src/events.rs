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

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct NotificationActivated {
    pub account_id: Option<i64>,
    pub folder_id: Option<i64>,
    pub thread_id: Option<i64>,
    pub message_id: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::NotificationActivated;

    #[test]
    fn activation_carries_full_target() {
        let ev = NotificationActivated {
            account_id: Some(1),
            folder_id: Some(2),
            thread_id: Some(3),
            message_id: Some(4),
        };
        assert_eq!(ev.account_id, Some(1));
        assert_eq!(ev.folder_id, Some(2));
        assert_eq!(ev.thread_id, Some(3));
        assert_eq!(ev.message_id, Some(4));
    }

    #[test]
    fn activation_allows_focus_only_target() {
        let ev = NotificationActivated {
            account_id: None,
            folder_id: None,
            thread_id: None,
            message_id: None,
        };
        assert!(ev.account_id.is_none());
        assert!(ev.folder_id.is_none());
    }
}
