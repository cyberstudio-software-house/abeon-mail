use am_sync::{SyncEvent, SyncEventSink};
use tauri::AppHandle;
use tauri_specta::Event;

use crate::events::{MailboxChanged, NewMessages, SyncProgress};

pub struct AppEventSink {
    pub app: AppHandle,
}

impl SyncEventSink for AppEventSink {
    fn emit(&self, event: SyncEvent) {
        match event {
            SyncEvent::Progress { account_id, folder_id, fetched, total } => {
                let _ = SyncProgress { account_id, folder_id, fetched, total }.emit(&self.app);
            }
            SyncEvent::NewMessages { account_id, folder_id, count } => {
                let _ = NewMessages { account_id, folder_id, count }.emit(&self.app);
            }
            SyncEvent::MailboxChanged { account_id, folder_id } => {
                let _ = MailboxChanged { account_id, folder_id }.emit(&self.app);
            }
        }
    }
}
