use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct NotificationContent {
    pub title: String,
    pub body: String,
}
