use std::sync::Arc;

use am_storage::Database;
use am_sync::engine::SyncEngine;

pub struct AppState {
    pub db: Arc<Database>,
    pub engine: std::sync::Mutex<Option<Arc<SyncEngine>>>,
}

impl AppState {
    pub fn new(db: Database) -> Self {
        Self { db: Arc::new(db), engine: std::sync::Mutex::new(None) }
    }
}
