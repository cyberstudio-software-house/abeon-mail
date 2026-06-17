use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use am_protocols::imap::{IdleOutcome, ImapSession};
use am_storage::{accounts_repo, folders_repo, Database};
use tokio::sync::mpsc;

use crate::events::SyncEventSink;
use crate::service::{self, imap_config_pub, load_endpoints_pub};

pub const POLL_INTERVAL: Duration = Duration::from_secs(300);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(1500);
const INBOX_PATH: &str = "INBOX";

pub struct SyncEngine {
    db: Arc<Database>,
    sink: Arc<dyn SyncEventSink>,
    workers: Mutex<HashMap<i64, mpsc::Sender<()>>>,
}

impl SyncEngine {
    pub fn start(db: Arc<Database>, sink: Arc<dyn SyncEventSink>) -> Arc<Self> {
        let engine = Arc::new(Self {
            db,
            sink,
            workers: Mutex::new(HashMap::new()),
        });
        if let Ok(accounts) = accounts_repo::list_accounts(&engine.db) {
            for account in accounts {
                engine.spawn_account(account.id);
            }
        }
        engine
    }

    pub fn spawn_account(self: &Arc<Self>, account_id: i64) {
        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        {
            let mut guard = self.workers.lock().unwrap();
            if guard.contains_key(&account_id) {
                return;
            }
            guard.insert(account_id, stop_tx);
        }
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        tokio::spawn(async move {
            let _ = service::sync_all_folders(&db, account_id, |_| {}).await;
            loop {
                let now = service::now_secs();
                let _ = service::drain_queue(&db, account_id, now).await;
                let _ = crate::send::drain_outbox(&db, account_id, now).await;
                if let Ok(folders) = folders_repo::list_folders(&db, account_id) {
                    for folder in &folders {
                        if !folder.remote_path.eq_ignore_ascii_case(INBOX_PATH) {
                            let _ = service::incremental_sync_folder(
                                &db,
                                account_id,
                                folder.id,
                                sink.as_ref(),
                            )
                            .await;
                        }
                    }
                    if let Some(inbox) = folders
                        .iter()
                        .find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH))
                    {
                        let _ = service::incremental_sync_folder(
                            &db,
                            account_id,
                            inbox.id,
                            sink.as_ref(),
                        )
                        .await;
                        let idled = idle_inbox(&db, account_id, &inbox.remote_path).await;
                        if matches!(idled, Ok(true)) {
                            continue;
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(POLL_INTERVAL) => {},
                    _ = stop_rx.recv() => break,
                }
            }
        });
    }

    pub fn shutdown(&self) {
        let mut guard = self.workers.lock().unwrap();
        guard.clear();
    }
}

async fn idle_inbox(db: &Database, account_id: i64, remote_path: &str) -> Result<bool, ()> {
    let account = accounts_repo::get_account(db, account_id).map_err(|_| ())?;
    let endpoints = load_endpoints_pub(db, account_id).map_err(|_| ())?;
    let password = am_auth::credentials::load_password(&account.email).map_err(|_| ())?;
    let config = imap_config_pub(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await.map_err(|_| ())?;
    let caps = session.server_caps().await.map_err(|_| ())?;
    if !caps.idle {
        let _ = session.logout().await;
        return Ok(false);
    }
    session.select(remote_path).await.map_err(|_| ())?;
    let (session, outcome) = session.idle_wait(IDLE_TIMEOUT).await.map_err(|_| ())?;
    let _ = session.logout().await;
    Ok(matches!(outcome, IdleOutcome::Changed))
}
