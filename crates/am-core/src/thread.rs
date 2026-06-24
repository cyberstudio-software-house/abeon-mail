use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct ThreadSummary {
    pub thread_id: i64,
    pub account_id: i64,
    pub subject: String,
    pub last_date: i64,
    pub message_count: i64,
    pub unread_count: i64,
    pub participants: Vec<String>,
    pub snippet: String,
    pub has_attachments: bool,
    pub flagged: bool,
    pub answered: bool,
}
