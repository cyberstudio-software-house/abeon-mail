use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use am_protocols::imap::{IdleOutcome, ImapSession};
use am_storage::{accounts_repo, folders_repo, Database};
use tokio_util::sync::CancellationToken;

use crate::auth::CredentialSource;
use crate::events::SyncEventSink;
use crate::service::{self, imap_config_pub, load_endpoints_pub};

pub const POLL_INTERVAL: Duration = Duration::from_secs(300);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(1500);
pub const WAKE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const INBOX_PATH: &str = "INBOX";

pub fn run_wake_sweep_at(db: &Database, sink: &dyn SyncEventSink, now: i64) {
    match am_storage::snooze_repo::wake_due(db, now) {
        Ok(count) if count > 0 => {
            sink.emit(crate::events::SyncEvent::SnoozeWoke { count });
        }
        _ => {}
    }
}

pub fn run_wake_sweep(db: &Database, sink: &dyn SyncEventSink) {
    run_wake_sweep_at(db, sink, service::now_secs());
}

pub struct SyncEngine {
    db: Arc<Database>,
    sink: Arc<dyn SyncEventSink>,
    creds: Arc<dyn CredentialSource>,
    pub workers: Mutex<HashMap<i64, CancellationToken>>,
}

impl SyncEngine {
    pub fn start(
        db: Arc<Database>,
        sink: Arc<dyn SyncEventSink>,
        creds: Arc<dyn CredentialSource>,
    ) -> Arc<Self> {
        let engine = Arc::new(Self {
            db,
            sink,
            creds,
            workers: Mutex::new(HashMap::new()),
        });
        if let Ok(accounts) = accounts_repo::list_accounts(&engine.db) {
            for account in accounts {
                engine.spawn_account(account.id);
            }
        }
        engine.spawn_wake_sweeper();
        engine
    }

    pub fn spawn_account(self: &Arc<Self>, account_id: i64) {
        let token = CancellationToken::new();
        {
            let mut guard = self.workers.lock().unwrap();
            if guard.contains_key(&account_id) {
                return;
            }
            guard.insert(account_id, token.clone());
        }
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        let creds = Arc::clone(&self.creds);
        tokio::spawn(async move {
            if let Err(e) = service::sync_all_folders(&db, account_id, creds.as_ref(), |_| {}).await {
                if matches!(e, service::SyncError::NeedsReauth) {
                    let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                    sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                    return;
                }
            }
            loop {
                let now = service::now_secs();
                if let Err(e) = service::drain_queue(&db, account_id, creds.as_ref(), now).await {
                    if matches!(e, service::SyncError::NeedsReauth) {
                        let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                        sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                        return;
                    }
                }
                let _ = crate::send::drain_outbox(&db, account_id, creds.as_ref(), now).await;
                let _ = crate::send::drain_draft_sync(&db, account_id, creds.as_ref(), now).await;
                if let Ok(folders) = folders_repo::list_folders(&db, account_id) {
                    for folder in &folders {
                        if !folder.remote_path.eq_ignore_ascii_case(INBOX_PATH) {
                            if let Err(e) = service::incremental_sync_folder(
                                &db,
                                account_id,
                                folder.id,
                                creds.as_ref(),
                                sink.as_ref(),
                            )
                            .await {
                                if matches!(e, service::SyncError::NeedsReauth) {
                                    let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                                    sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                                    return;
                                }
                            }
                        }
                    }
                    if let Some(inbox) = folders
                        .iter()
                        .find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH))
                    {
                        if let Err(e) = service::incremental_sync_folder(
                            &db,
                            account_id,
                            inbox.id,
                            creds.as_ref(),
                            sink.as_ref(),
                        )
                        .await {
                            if matches!(e, service::SyncError::NeedsReauth) {
                                let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                                sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                                return;
                            }
                        }
                        let idled = idle_inbox(&db, account_id, &inbox.remote_path, creds.as_ref(), token.clone()).await;
                        if matches!(idled, Ok(true)) {
                            continue;
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(POLL_INTERVAL) => {},
                    _ = token.cancelled() => break,
                }
            }
        });
    }

    pub fn spawn_wake_sweeper(self: &Arc<Self>) {
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        tokio::spawn(async move {
            loop {
                run_wake_sweep(&db, sink.as_ref());
                tokio::time::sleep(WAKE_SWEEP_INTERVAL).await;
            }
        });
    }

    pub fn stop_account(&self, account_id: i64) {
        let mut guard = self.workers.lock().unwrap();
        if let Some(token) = guard.remove(&account_id) {
            token.cancel();
        }
    }

    pub fn shutdown(&self) {
        let mut guard = self.workers.lock().unwrap();
        for (_, token) in guard.drain() {
            token.cancel();
        }
    }
}

async fn idle_inbox(
    db: &Database,
    account_id: i64,
    remote_path: &str,
    creds: &dyn CredentialSource,
    token: CancellationToken,
) -> Result<bool, ()> {
    let account = accounts_repo::get_account(db, account_id).map_err(|_| ())?;
    let endpoints = load_endpoints_pub(db, account_id).map_err(|_| ())?;
    let auth = creds.auth_for(&account).await.map_err(|_| ())?;
    let config = imap_config_pub(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await.map_err(|_| ())?;
    let caps = session.server_caps().await.map_err(|_| ())?;
    if !caps.idle {
        let _ = session.logout().await;
        return Ok(false);
    }
    session.select(remote_path).await.map_err(|_| ())?;
    let idle_fut = session.idle_wait(IDLE_TIMEOUT);
    tokio::select! {
        result = idle_fut => {
            match result {
                Ok((session_after, outcome)) => {
                    let _ = session_after.logout().await;
                    Ok(matches!(outcome, IdleOutcome::Changed))
                }
                Err(_) => Err(()),
            }
        }
        _ = token.cancelled() => {
            Err(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use am_storage::Database;
    use crate::events::NoopSink;
    use am_storage::{accounts_repo, folders_repo, snooze_repo};
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;
    use crate::events::RecordingSink;

    fn seed_due_message(db: &Database) {
        let acc = accounts_repo::insert_account(db, &NewAccount {
            email: "w@e.com".into(), display_name: "W".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = folders_repo::upsert_folder(db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        am_storage::messages_repo::insert_headers(db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: Some("<w1@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: None, subject: "S".into(), date: 100,
            seen: true, flagged: false, has_attachments: false, size: 0, snippet: String::new(),
        }]).unwrap();
        let msgs = am_storage::messages_repo::list_by_folder(db, folder.id, 10, 0, 0).unwrap();
        let id = msgs[0].id;
        snooze_repo::snooze_messages(db, &[id], 1000).unwrap();
    }

    #[test]
    fn run_wake_sweep_emits_when_messages_wake() {
        let db = Database::open_in_memory().unwrap();
        seed_due_message(&db);
        let sink = RecordingSink::new();
        run_wake_sweep_at(&db, &sink, 5000);
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], crate::events::SyncEvent::SnoozeWoke { count: 1 }));
    }

    #[test]
    fn run_wake_sweep_silent_when_nothing_due() {
        let db = Database::open_in_memory().unwrap();
        let sink = RecordingSink::new();
        run_wake_sweep_at(&db, &sink, 5000);
        assert_eq!(sink.events.lock().unwrap().len(), 0);
    }

    struct FakeCreds;

    #[async_trait::async_trait]
    impl crate::auth::CredentialSource for FakeCreds {
        async fn auth_for(&self, _account: &am_core::account::Account) -> Result<crate::auth::AccountAuth, crate::service::SyncError> {
            Err(crate::service::SyncError::CredentialMissing)
        }
    }

    #[tokio::test]
    async fn spawn_then_stop_removes_worker_and_token_is_cancelled() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let token = CancellationToken::new();
        {
            let mut guard = engine.workers.lock().unwrap();
            guard.insert(42, token.clone());
        }

        engine.stop_account(42);

        assert!(token.is_cancelled());
        assert!(!engine.workers.lock().unwrap().contains_key(&42));
    }

    #[tokio::test]
    async fn shutdown_cancels_all_tokens() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let t1 = CancellationToken::new();
        let t2 = CancellationToken::new();
        {
            let mut guard = engine.workers.lock().unwrap();
            guard.insert(1, t1.clone());
            guard.insert(2, t2.clone());
        }

        engine.shutdown();

        assert!(t1.is_cancelled());
        assert!(t2.is_cancelled());
    }
}
