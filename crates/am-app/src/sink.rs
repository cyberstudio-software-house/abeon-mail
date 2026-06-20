use am_sync::{SyncEvent, SyncEventSink};
use tauri::AppHandle;
use tauri_specta::Event;

use crate::events::{AccountAuthChanged, MailboxChanged, NewMessages, SendFailed, SnoozeWoke, SyncProgress};

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
            SyncEvent::AuthChanged { account_id, requires_reauth } => {
                let _ = AccountAuthChanged { account_id, requires_reauth }.emit(&self.app);
            }
            SyncEvent::SnoozeWoke { count } => {
                let _ = SnoozeWoke { count }.emit(&self.app);
            }
            SyncEvent::SendFailed { account_id, error } => {
                let _ = SendFailed { account_id, error }.emit(&self.app);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::events::AccountAuthChanged;

    #[test]
    fn auth_changed_event_struct_has_correct_fields() {
        let ev = AccountAuthChanged { account_id: 7, requires_reauth: true };
        assert_eq!(ev.account_id, 7);
        assert!(ev.requires_reauth);
    }

    #[test]
    fn snooze_woke_event_struct_has_count() {
        let ev = crate::events::SnoozeWoke { count: 3 };
        assert_eq!(ev.count, 3);
    }
}
