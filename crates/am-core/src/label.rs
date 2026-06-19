use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Label {
    pub id: i64,
    pub name: String,
    pub color: String,
}
