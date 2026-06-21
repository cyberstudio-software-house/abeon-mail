use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Signature {
    pub id: i64,
    pub name: String,
    pub html: String,
    pub is_default: bool,
    pub is_html: bool,
}
