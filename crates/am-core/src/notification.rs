use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct NotificationContent {
    pub title: String,
    pub body: String,
    pub thread_id: Option<i64>,
    pub message_id: Option<i64>,
}
