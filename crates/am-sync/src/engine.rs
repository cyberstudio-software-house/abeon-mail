use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use am_protocols::imap::{IdleOutcome, ImapSession, MailboxState};
use am_storage::{accounts_repo, folders_repo, Database};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::auth::CredentialSource;
use crate::events::SyncEventSink;
use crate::service::{self, imap_config_pub, load_endpoints_pub};

pub const POLL_INTERVAL: Duration = Duration::from_secs(300);
pub const IDLE_REFRESH: Duration = Duration::from_secs(240);
pub const IDLE_ERROR_BACKOFF: Duration = Duration::from_secs(15);
pub const WAKE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
pub const PREFETCH_IDLE_INTERVAL: Duration = Duration::from_secs(60);
pub const PREFETCH_WORK_PAUSE: Duration = Duration::from_secs(2);
pub const FULL_SCAN_INTERVAL: Duration = Duration::from_secs(300);
pub const SYNC_PHASE_DEADLINE: Duration = Duration::from_secs(180);
pub const DRAIN_PHASE_DEADLINE: Duration = Duration::from_secs(600);
pub const STARTUP_SYNC_DEADLINE: Duration = Duration::from_secs(600);
pub const IDLE_DONE_GRACE: Duration = Duration::from_secs(30);
const INBOX_PATH: &str = "INBOX";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleOutcomeKind {
    Changed,
    Refreshed,
    Unsupported,
}

fn should_resync_after_idle(outcome: &Result<IdleOutcomeKind, ()>) -> bool {
    matches!(
        outcome,
        Ok(IdleOutcomeKind::Changed) | Ok(IdleOutcomeKind::Refreshed)
    )
}

fn should_full_scan(elapsed: Duration, interval: Duration) -> bool {
    elapsed >= interval
}

fn mailbox_changed_before_idle(markers: &folders_repo::SyncMarkers, state: &MailboxState) -> bool {
    if markers.uidvalidity != Some(state.uidvalidity) {
        return true;
    }
    markers.uidnext.is_some_and(|marker| state.uidnext > marker)
}

fn capped_idle_timeout(idle_refresh: Duration, scan_interval: Duration, since_scan: Duration) -> Duration {
    idle_refresh.min(scan_interval.saturating_sub(since_scan))
}

fn idle_hard_deadline(timeout: Duration) -> Duration {
    timeout + IDLE_DONE_GRACE
}

async fn with_deadline<T>(
    limit: Duration,
    fut: impl std::future::Future<Output = Result<T, service::SyncError>>,
) -> Result<T, service::SyncError> {
    match tokio::time::timeout(limit, fut).await {
        Ok(result) => result,
        Err(_) => Err(service::SyncError::Protocol("sync phase deadline exceeded".into())),
    }
}

fn needs_reauth(err: &service::SyncError) -> bool {
    matches!(err, service::SyncError::Auth | service::SyncError::NeedsReauth)
}

fn flag_reauth(db: &Database, sink: &dyn SyncEventSink, account_id: i64) {
    let _ = accounts_repo::set_requires_reauth(db, account_id, true);
    sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
}

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
    wakeups: Mutex<HashMap<i64, Arc<Notify>>>,
    prefetch_wakeups: Mutex<HashMap<i64, Arc<Notify>>>,
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
            wakeups: Mutex::new(HashMap::new()),
            prefetch_wakeups: Mutex::new(HashMap::new()),
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
        let notify = Arc::new(Notify::new());
        let prefetch_notify = Arc::new(Notify::new());
        {
            let mut guard = self.workers.lock().unwrap();
            if guard.contains_key(&account_id) {
                return;
            }
            guard.insert(account_id, token.clone());
        }
        self.wakeups.lock().unwrap().insert(account_id, Arc::clone(&notify));
        self.prefetch_wakeups.lock().unwrap().insert(account_id, Arc::clone(&prefetch_notify));
        self.spawn_prefetch(account_id, token.clone(), Arc::clone(&prefetch_notify));
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        let creds = Arc::clone(&self.creds);
        tokio::spawn(async move {
            if let Err(e) = with_deadline(STARTUP_SYNC_DEADLINE, service::sync_all_folders(&db, account_id, creds.as_ref(), |_| {})).await {
                if needs_reauth(&e) {
                    flag_reauth(&db, sink.as_ref(), account_id);
                    return;
                }
            }
            let mut last_full_scan = std::time::Instant::now();
            loop {
                let now = service::now_secs();
                if let Err(e) = with_deadline(DRAIN_PHASE_DEADLINE, service::drain_queue(&db, account_id, creds.as_ref(), now)).await {
                    if needs_reauth(&e) {
                        flag_reauth(&db, sink.as_ref(), account_id);
                        return;
                    }
                }
                let _ = with_deadline(DRAIN_PHASE_DEADLINE, crate::send::drain_outbox(&db, account_id, creds.as_ref(), sink.as_ref(), now)).await;
                let _ = with_deadline(DRAIN_PHASE_DEADLINE, crate::send::drain_invite_replies(&db, account_id, creds.as_ref(), sink.as_ref(), now)).await;
                let _ = with_deadline(DRAIN_PHASE_DEADLINE, crate::send::drain_draft_sync(&db, account_id, creds.as_ref(), now)).await;
                let mut backoff = POLL_INTERVAL;
                let mut new_mail = 0i64;
                let mut inbox_synced = false;
                if let Ok(folders) = folders_repo::list_folders(&db, account_id) {
                    let inbox = folders
                        .iter()
                        .find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH));
                    if let Some(inbox) = inbox {
                        match with_deadline(SYNC_PHASE_DEADLINE, service::incremental_sync_folder(
                            &db,
                            account_id,
                            inbox.id,
                            creds.as_ref(),
                            sink.as_ref(),
                        ))
                        .await {
                            Ok(count) => {
                                new_mail += count;
                                inbox_synced = true;
                            }
                            Err(e) => {
                                if needs_reauth(&e) {
                                    flag_reauth(&db, sink.as_ref(), account_id);
                                    return;
                                }
                            }
                        }
                    }

                    if should_full_scan(last_full_scan.elapsed(), FULL_SCAN_INTERVAL) {
                        match with_deadline(DRAIN_PHASE_DEADLINE, service::full_scan_account(&db, account_id, creds.as_ref(), sink.as_ref())).await {
                            Ok(count) => new_mail += count,
                            Err(e) => {
                                if needs_reauth(&e) {
                                    flag_reauth(&db, sink.as_ref(), account_id);
                                    return;
                                }
                            }
                        }
                        last_full_scan = std::time::Instant::now();
                    }

                    if new_mail > 0 {
                        prefetch_notify.notify_one();
                    }

                    if let Some(inbox) = inbox {
                        let idle_for = capped_idle_timeout(IDLE_REFRESH, FULL_SCAN_INTERVAL, last_full_scan.elapsed());
                        if idle_for.is_zero() {
                            continue;
                        }
                        let idled = idle_inbox(
                            &db,
                            account_id,
                            inbox.id,
                            &inbox.remote_path,
                            creds.as_ref(),
                            inbox_synced,
                            idle_for,
                            token.clone(),
                            Arc::clone(&notify),
                        )
                        .await;
                        if should_resync_after_idle(&idled) {
                            continue;
                        }
                        if idled.is_err() {
                            backoff = IDLE_ERROR_BACKOFF;
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {},
                    _ = notify.notified() => {},
                    _ = token.cancelled() => break,
                }
            }
        });
    }

    pub fn spawn_prefetch(self: &Arc<Self>, account_id: i64, token: CancellationToken, notify: Arc<Notify>) {
        let db = Arc::clone(&self.db);
        let sink = Arc::clone(&self.sink);
        let creds = Arc::clone(&self.creds);
        tokio::spawn(async move {
            loop {
                if token.is_cancelled() {
                    break;
                }
                let contacts_worked =
                    match service::run_contacts_backfill_batch(&db, account_id, creds.as_ref()).await {
                        Ok(worked) => worked,
                        Err(_) => false,
                    };
                let prefetch_worked = match service::run_prefetch_batch(&db, account_id, creds.as_ref(), sink.as_ref()).await {
                    Ok(worked) => worked,
                    Err(service::SyncError::NeedsReauth) => {
                        let _ = am_storage::accounts_repo::set_requires_reauth(&db, account_id, true);
                        sink.emit(crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true });
                        return;
                    }
                    Err(_) => false,
                };
                let did_work = contacts_worked || prefetch_worked;
                let pause = if did_work { PREFETCH_WORK_PAUSE } else { PREFETCH_IDLE_INTERVAL };
                tokio::select! {
                    _ = tokio::time::sleep(pause) => {},
                    _ = notify.notified() => {},
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

    pub fn sync_now(&self) {
        for notify in self.wakeups.lock().unwrap().values() {
            notify.notify_one();
        }
        for notify in self.prefetch_wakeups.lock().unwrap().values() {
            notify.notify_one();
        }
    }

    pub fn wake_account(&self, account_id: i64) {
        if let Some(notify) = self.wakeups.lock().unwrap().get(&account_id) {
            notify.notify_one();
        }
    }

    pub fn wake_prefetch(&self, account_id: i64) {
        if let Some(notify) = self.prefetch_wakeups.lock().unwrap().get(&account_id) {
            notify.notify_one();
        }
    }

    pub fn stop_account(&self, account_id: i64) {
        let mut guard = self.workers.lock().unwrap();
        if let Some(token) = guard.remove(&account_id) {
            token.cancel();
        }
        self.wakeups.lock().unwrap().remove(&account_id);
        self.prefetch_wakeups.lock().unwrap().remove(&account_id);
    }

    pub fn shutdown(&self) {
        let mut guard = self.workers.lock().unwrap();
        for (_, token) in guard.drain() {
            token.cancel();
        }
        self.wakeups.lock().unwrap().clear();
        self.prefetch_wakeups.lock().unwrap().clear();
    }
}

pub async fn idle_inbox(
    db: &Database,
    account_id: i64,
    folder_id: i64,
    remote_path: &str,
    creds: &dyn CredentialSource,
    allow_uidnext_skip: bool,
    timeout: Duration,
    token: CancellationToken,
    notify: Arc<Notify>,
) -> Result<IdleOutcomeKind, ()> {
    let account = accounts_repo::get_account(db, account_id).map_err(|_| ())?;
    let endpoints = load_endpoints_pub(db, account_id).map_err(|_| ())?;
    let auth = creds.auth_for(&account).await.map_err(|_| ())?;
    let config = imap_config_pub(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &auth.to_imap()).await.map_err(|_| ())?;
    let caps = session.server_caps().await.map_err(|_| ())?;
    if !caps.idle {
        let _ = session.logout().await;
        return Ok(IdleOutcomeKind::Unsupported);
    }
    let state = session.select(remote_path).await.map_err(|_| ())?;
    if allow_uidnext_skip {
        let markers = folders_repo::get_sync_markers(db, folder_id).map_err(|_| ())?;
        if mailbox_changed_before_idle(&markers, &state) {
            tokio::spawn(async move {
                let _ = session.logout().await;
            });
            return Ok(IdleOutcomeKind::Changed);
        }
    }
    let idle_fut = tokio::time::timeout(idle_hard_deadline(timeout), session.idle_wait(timeout));
    tokio::select! {
        result = idle_fut => {
            match result {
                Ok(Ok((session_after, outcome))) => {
                    tokio::spawn(async move {
                        let _ = session_after.logout().await;
                    });
                    match outcome {
                        IdleOutcome::Changed => Ok(IdleOutcomeKind::Changed),
                        IdleOutcome::TimedOut => Ok(IdleOutcomeKind::Refreshed),
                    }
                }
                Ok(Err(_)) => Err(()),
                Err(_) => Err(()),
            }
        }
        _ = notify.notified() => {
            Ok(IdleOutcomeKind::Changed)
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

    #[test]
    fn full_scan_only_after_interval_elapsed() {
        let interval = Duration::from_secs(300);
        assert!(!should_full_scan(Duration::from_secs(0), interval));
        assert!(!should_full_scan(Duration::from_secs(299), interval));
        assert!(should_full_scan(Duration::from_secs(300), interval));
        assert!(should_full_scan(Duration::from_secs(600), interval));
    }

    fn seed_due_message(db: &Database) {
        let acc = accounts_repo::insert_account(db, &NewAccount {
            email: "w@e.com".into(), display_name: "W".into(),
            provider_type: ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = folders_repo::upsert_folder(db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        am_storage::messages_repo::insert_headers(db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: Some("<w1@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: None, subject: "S".into(), date: 100,
            seen: true, flagged: false, answered: false, has_attachments: false, size: 0, snippet: String::new(),
        }]).unwrap();
        let msgs = am_storage::messages_repo::list_by_folder(db, folder.id, 10, 0, 0).unwrap();
        let id = msgs[0].id;
        snooze_repo::snooze_messages(db, &[id], 1000).unwrap();
    }

    fn markers(uidvalidity: Option<i64>, uidnext: Option<i64>) -> folders_repo::SyncMarkers {
        folders_repo::SyncMarkers { uidvalidity, uidnext, highestmodseq: None }
    }

    fn state(uidvalidity: i64, uidnext: i64) -> MailboxState {
        MailboxState { uidvalidity, uidnext, exists: 0, highestmodseq: None }
    }

    #[test]
    fn mail_arriving_before_idle_is_detected_from_select_uidnext() {
        assert!(mailbox_changed_before_idle(&markers(Some(1), Some(100)), &state(1, 101)));
        assert!(mailbox_changed_before_idle(&markers(Some(1), Some(100)), &state(1, 150)));
    }

    #[test]
    fn unchanged_uidnext_enters_idle_normally() {
        assert!(!mailbox_changed_before_idle(&markers(Some(1), Some(100)), &state(1, 100)));
        assert!(!mailbox_changed_before_idle(&markers(Some(1), Some(100)), &state(1, 99)));
    }

    #[test]
    fn missing_uidnext_marker_enters_idle_normally() {
        assert!(!mailbox_changed_before_idle(&markers(Some(1), None), &state(1, 5)));
    }

    #[test]
    fn uidvalidity_change_forces_resync_instead_of_idle() {
        assert!(mailbox_changed_before_idle(&markers(Some(1), Some(100)), &state(2, 100)));
        assert!(mailbox_changed_before_idle(&markers(None, Some(100)), &state(1, 100)));
    }

    #[test]
    fn idle_timeout_uses_full_refresh_right_after_scan() {
        assert_eq!(
            capped_idle_timeout(IDLE_REFRESH, FULL_SCAN_INTERVAL, Duration::from_secs(0)),
            IDLE_REFRESH
        );
    }

    #[test]
    fn idle_timeout_shrinks_to_next_scan_deadline() {
        assert_eq!(
            capped_idle_timeout(IDLE_REFRESH, FULL_SCAN_INTERVAL, Duration::from_secs(120)),
            Duration::from_secs(180)
        );
    }

    #[test]
    fn idle_timeout_zero_when_scan_overdue() {
        assert_eq!(
            capped_idle_timeout(IDLE_REFRESH, FULL_SCAN_INTERVAL, Duration::from_secs(400)),
            Duration::ZERO
        );
    }

    #[test]
    fn idle_hard_deadline_extends_timeout_by_grace() {
        assert_eq!(idle_hard_deadline(IDLE_REFRESH), IDLE_REFRESH + IDLE_DONE_GRACE);
    }

    #[tokio::test]
    async fn with_deadline_converts_hang_into_protocol_error() {
        let result = with_deadline(
            Duration::from_millis(10),
            std::future::pending::<Result<(), service::SyncError>>(),
        )
        .await;
        assert!(matches!(result, Err(service::SyncError::Protocol(_))));
    }

    #[tokio::test]
    async fn with_deadline_passes_through_completed_result() {
        let result = with_deadline(Duration::from_secs(5), async { Ok::<i64, service::SyncError>(7) }).await;
        assert_eq!(result.unwrap(), 7);
    }

    #[test]
    fn idle_change_triggers_resync() {
        assert!(should_resync_after_idle(&Ok(IdleOutcomeKind::Changed)));
    }

    #[test]
    fn idle_refresh_triggers_resync() {
        assert!(should_resync_after_idle(&Ok(IdleOutcomeKind::Refreshed)));
    }

    #[test]
    fn idle_unsupported_falls_back_to_poll() {
        assert!(!should_resync_after_idle(&Ok(IdleOutcomeKind::Unsupported)));
    }

    #[test]
    fn idle_error_falls_back_to_poll() {
        assert!(!should_resync_after_idle(&Err(())));
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

    #[test]
    fn rejected_credentials_flag_reauth() {
        assert!(needs_reauth(&service::SyncError::Auth));
        assert!(needs_reauth(&service::SyncError::NeedsReauth));
    }

    #[test]
    fn recoverable_errors_do_not_flag_reauth() {
        assert!(!needs_reauth(&service::SyncError::Protocol("connection lost".into())));
        assert!(!needs_reauth(&service::SyncError::InvalidSettings));
        assert!(!needs_reauth(&service::SyncError::Keychain));
        assert!(!needs_reauth(&service::SyncError::CredentialMissing));
    }

    #[test]
    fn flag_reauth_persists_flag_and_emits_event() {
        let db = Database::open_in_memory().unwrap();
        let account = accounts_repo::insert_account(&db, &NewAccount {
            email: "scope@e.com".into(), display_name: "S".into(),
            provider_type: ProviderType::GoogleOauth, color: None,
        }).unwrap();
        let sink = RecordingSink::new();

        flag_reauth(&db, &sink, account.id);

        let stored = accounts_repo::get_account(&db, account.id).unwrap();
        assert!(stored.requires_reauth);
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0],
            crate::events::SyncEvent::AuthChanged { account_id, requires_reauth: true } if account_id == account.id
        ));
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

    #[tokio::test]
    async fn stop_account_clears_prefetch_wakeup() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        engine.workers.lock().unwrap().insert(7, CancellationToken::new());
        engine.prefetch_wakeups.lock().unwrap().insert(7, Arc::new(Notify::new()));

        engine.stop_account(7);

        assert!(!engine.prefetch_wakeups.lock().unwrap().contains_key(&7));
    }

    #[tokio::test]
    async fn shutdown_clears_prefetch_wakeups() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        engine.prefetch_wakeups.lock().unwrap().insert(1, Arc::new(Notify::new()));
        engine.prefetch_wakeups.lock().unwrap().insert(2, Arc::new(Notify::new()));

        engine.shutdown();

        assert!(engine.prefetch_wakeups.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn wake_account_signals_main_worker() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let notify = Arc::new(Notify::new());
        engine.wakeups.lock().unwrap().insert(42, Arc::clone(&notify));
        let waiter = tokio::spawn(async move { notify.notified().await });

        engine.wake_account(42);

        let woken = tokio::time::timeout(Duration::from_secs(1), waiter).await;
        assert!(woken.is_ok(), "wake_account should signal the account's main worker");
    }

    #[tokio::test]
    async fn wake_prefetch_signals_waiting_task() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let notify = Arc::new(Notify::new());
        engine.prefetch_wakeups.lock().unwrap().insert(42, Arc::clone(&notify));
        let waiter = tokio::spawn(async move { notify.notified().await });

        engine.wake_prefetch(42);

        let woken = tokio::time::timeout(Duration::from_secs(1), waiter).await;
        assert!(woken.is_ok(), "wake_prefetch should signal the account's prefetch task");
    }

    #[tokio::test]
    async fn sync_now_signals_prefetch_wakeups() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let sink = Arc::new(NoopSink);
        let creds: Arc<dyn crate::auth::CredentialSource> = Arc::new(FakeCreds);
        let engine = SyncEngine::start(Arc::clone(&db), sink, creds);

        let notify = Arc::new(Notify::new());
        engine.prefetch_wakeups.lock().unwrap().insert(9, Arc::clone(&notify));
        let waiter = tokio::spawn(async move { notify.notified().await });

        engine.sync_now();

        let woken = tokio::time::timeout(Duration::from_secs(1), waiter).await;
        assert!(woken.is_ok(), "sync_now should also wake prefetch tasks");
    }
}
