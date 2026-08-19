use std::any::Any;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, Once};
use std::time::Duration;

use am_auth::endpoints::Endpoints;
use am_core::folder::FolderType;
use am_storage::{accounts_repo, folders_repo, messages_repo, Database};
use am_sync::service::{self, AddAccountInput, MoveTarget, UNDO_GRACE_SECS};
use async_imap::Client;
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence};
use testcontainers::core::{ContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};
use tokio::net::TcpStream;

const IMAP_PORT: u16 = 3143;
const USER: &str = "sync-user@localhost";
const PASSWORD: &str = "sync-secret";

const SUBJECT_ONE: &str = "Sync Seed One";
const BODY_ONE: &str = "First sync body marker GAMMA";
const SUBJECT_TWO: &str = "Sync Seed Two";
const BODY_TWO: &str = "Second sync body marker DELTA";
const SUBJECT_THREE: &str = "Sync Seed Three";
const BODY_THREE: &str = "Third sync body marker EPSILON";

static STORE: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
static INIT: Once = Once::new();

fn install_in_mem_builder() {
    INIT.call_once(|| {
        *STORE.lock().unwrap() = Some(HashMap::new());
        keyring::set_default_credential_builder(Box::new(InMemCredBuilder));
    });
}

#[derive(Debug)]
struct InMemCred {
    service: String,
    user: String,
}

impl CredentialApi for InMemCred {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        let password = String::from_utf8(secret.to_vec())
            .map_err(|_| keyring::Error::BadEncoding(secret.to_vec()))?;
        let mut guard = STORE.lock().unwrap();
        let map = guard.as_mut().unwrap();
        map.insert((self.service.clone(), self.user.clone()), password);
        Ok(())
    }

    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        let guard = STORE.lock().unwrap();
        let map = guard.as_ref().unwrap();
        match map.get(&(self.service.clone(), self.user.clone())) {
            Some(pw) => Ok(pw.as_bytes().to_vec()),
            None => Err(keyring::Error::NoEntry),
        }
    }

    fn delete_credential(&self) -> keyring::Result<()> {
        let mut guard = STORE.lock().unwrap();
        let map = guard.as_mut().unwrap();
        match map.remove(&(self.service.clone(), self.user.clone())) {
            Some(_) => Ok(()),
            None => Err(keyring::Error::NoEntry),
        }
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

struct InMemCredBuilder;

impl CredentialBuilderApi for InMemCredBuilder {
    fn build(
        &self,
        _target: Option<&str>,
        service: &str,
        user: &str,
    ) -> keyring::Result<Box<Credential>> {
        Ok(Box::new(InMemCred {
            service: service.to_string(),
            user: user.to_string(),
        }))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn persistence(&self) -> CredentialPersistence {
        CredentialPersistence::ProcessOnly
    }
}

fn docker_available() -> bool {
    Command::new("docker")
        .arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn raw_message(subject: &str, body: &str) -> String {
    format!(
        "From: Sender <sender@example.com>\r\nTo: {USER}\r\nSubject: {subject}\r\nDate: Wed, 17 Jun 2026 10:00:00 +0000\r\nMessage-ID: <{subject}@example.com>\r\n\r\n{body}\r\n"
    )
}

async fn open_seed_session(port: u16) -> async_imap::Session<TcpStream> {
    for attempt in 0..20 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let tcp = match TcpStream::connect(("127.0.0.1", port)).await {
            Ok(tcp) => tcp,
            Err(_) => continue,
        };
        if let Ok(session) = Client::new(tcp).login(USER, PASSWORD).await.map_err(|(e, _)| e) {
            return session;
        }
    }
    panic!("seed login failed after retries");
}

async fn seed_messages(port: u16) {
    let mut session = open_seed_session(port).await;

    for (subject, body) in [
        (SUBJECT_ONE, BODY_ONE),
        (SUBJECT_TWO, BODY_TWO),
        (SUBJECT_THREE, BODY_THREE),
    ] {
        session
            .append("INBOX", None, None, raw_message(subject, body).as_bytes())
            .await
            .expect("append failed");
    }

    session.create("Archive").await.ok();
    session
        .append("Archive", None, None, raw_message("Archived One", "archive marker ZETA").as_bytes())
        .await
        .expect("append to archive failed");

    session.logout().await.expect("seed logout failed");
}

#[tokio::test]
async fn add_account_syncs_inbox_and_fetches_body() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail sync integration test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image
        .start()
        .await
        .expect("failed to start greenmail container");

    let mapped_port = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    tokio::time::sleep(Duration::from_millis(500)).await;

    seed_messages(mapped_port).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };

    let db = Database::open_in_memory().expect("db open failed");

    let input = AddAccountInput {
        email: USER.to_string(),
        display_name: "Sync User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    };

    let account = service::add_account(&db, input)
        .await
        .expect("add_account failed");

    let accounts = accounts_repo::list_accounts(&db).expect("list_accounts failed");
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].id, account.id);

    let folders = folders_repo::list_folders(&db, account.id).expect("list_folders failed");
    assert!(
        folders
            .iter()
            .any(|f| f.remote_path.eq_ignore_ascii_case("INBOX")),
        "INBOX not found in folders: {folders:?}"
    );

    let inbox = folders
        .iter()
        .find(|f| f.remote_path.eq_ignore_ascii_case("INBOX"))
        .expect("inbox folder missing");

    let headers = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).expect("list_by_folder failed");
    assert_eq!(headers.len(), 3, "expected 3 headers, got {}", headers.len());

    let subjects: Vec<&str> = headers.iter().map(|h| h.subject.as_str()).collect();
    assert!(subjects.contains(&SUBJECT_ONE), "missing subject one: {subjects:?}");
    assert!(subjects.contains(&SUBJECT_TWO), "missing subject two: {subjects:?}");
    assert!(subjects.contains(&SUBJECT_THREE), "missing subject three: {subjects:?}");

    let first = &headers[0];
    let creds = am_sync::auth::KeychainCredentialSource::new();
    let body = service::get_or_fetch_body(&db, first.id, creds.as_ref())
        .await
        .expect("get_or_fetch_body failed");

    let combined = format!(
        "{}{}",
        body.text_plain.clone().unwrap_or_default(),
        body.text_html.clone().unwrap_or_default()
    );
    assert!(
        [BODY_ONE, BODY_TWO, BODY_THREE]
            .iter()
            .any(|marker| combined.contains(marker)),
        "fetched body did not contain any seeded marker: {combined}"
    );

    let cached = service::get_or_fetch_body(&db, first.id, creds.as_ref())
        .await
        .expect("cached get_or_fetch_body failed");
    assert_eq!(cached, body);

    let archive = folders
        .iter()
        .find(|f| f.remote_path.eq_ignore_ascii_case("Archive"))
        .expect("archive folder missing");
    let archive_headers = messages_repo::list_by_folder(&db, archive.id, 50, 0, i64::MAX).expect("archive list failed");
    assert_eq!(archive_headers.len(), 1, "expected 1 archived header");
    assert_eq!(archive_headers[0].subject, "Archived One");
}

async fn seed_inbox_only(port: u16) {
    let mut session = open_seed_session(port).await;

    for (subject, body) in [
        (SUBJECT_ONE, BODY_ONE),
        (SUBJECT_TWO, BODY_TWO),
        (SUBJECT_THREE, BODY_THREE),
    ] {
        session
            .append("INBOX", None, None, raw_message(subject, body).as_bytes())
            .await
            .expect("append failed");
    }

    session.logout().await.expect("seed logout failed");
}

#[tokio::test]
async fn archive_moves_message_out_of_inbox() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail archive e2e test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image
        .start()
        .await
        .expect("failed to start greenmail container");

    let mapped_port = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    tokio::time::sleep(Duration::from_millis(500)).await;

    seed_inbox_only(mapped_port).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };

    let db = Database::open_in_memory().expect("db open failed");

    let input = AddAccountInput {
        email: USER.to_string(),
        display_name: "Sync User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    };

    let account = service::add_account(&db, input)
        .await
        .expect("add_account failed");

    let inbox = folders_repo::find_by_type(&db, account.id, FolderType::Inbox)
        .unwrap()
        .expect("inbox folder missing");

    let headers = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
    assert_eq!(headers.len(), 3, "expected 3 headers in inbox before move");

    let first_id = headers[0].id;
    let first_subject = headers[0].subject.clone();

    service::enqueue_move(&db, first_id, MoveTarget::Archive, 0).unwrap();

    let creds = am_sync::auth::KeychainCredentialSource::new();
    service::drain_queue(&db, account.id, creds.as_ref(), UNDO_GRACE_SECS)
        .await
        .expect("drain_queue failed");

    assert_eq!(
        messages_repo::count_by_folder(&db, inbox.id).unwrap(),
        2,
        "source row must be hard-deleted on move, not left as an orphan"
    );

    service::sync_all_folders(&db, account.id, creds.as_ref(), |_| {})
        .await
        .ok();

    let archive = folders_repo::find_by_type(&db, account.id, FolderType::Archive)
        .unwrap()
        .expect("Archive type must survive folder discovery");

    let inbox_after = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
    assert_eq!(inbox_after.len(), 2, "inbox should have 2 messages after archiving one");
    assert!(
        !inbox_after.iter().any(|h| h.subject == first_subject),
        "archived message subject should not remain in inbox"
    );

    let archive_after = messages_repo::list_by_folder(&db, archive.id, 50, 0, i64::MAX).unwrap();
    assert_eq!(archive_after.len(), 1);
}

#[tokio::test]
async fn prefetch_downloads_bodies_without_marking_seen() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail prefetch integration test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image.start().await.expect("failed to start greenmail container");
    let mapped_port = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    tokio::time::sleep(Duration::from_millis(500)).await;
    seed_inbox_only(mapped_port).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };
    let db = Database::open_in_memory().expect("db open failed");
    let account = service::add_account(&db, AddAccountInput {
        email: USER.to_string(),
        display_name: "Sync User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    }).await.expect("add_account failed");

    let inbox = folders_repo::find_by_type(&db, account.id, FolderType::Inbox)
        .unwrap()
        .expect("inbox folder missing");

    assert_eq!(messages_repo::count_without_body(&db, inbox.id).unwrap(), 3);

    am_storage::settings_repo::set_setting(&db, &format!("prefetch.bodies.{}", account.id), "true").unwrap();
    am_storage::settings_repo::set_setting(
        &db,
        &format!("prefetch.folders.{}", account.id),
        &format!("[{}]", inbox.id),
    ).unwrap();

    let creds = am_sync::auth::KeychainCredentialSource::new();
    let sink = am_sync::events::NoopSink;
    let worked = service::run_prefetch_batch(&db, account.id, creds.as_ref(), &sink)
        .await
        .expect("run_prefetch_batch failed");
    assert!(worked, "prefetch should have done work");

    assert_eq!(messages_repo::count_without_body(&db, inbox.id).unwrap(), 0);
    assert!(folders_repo::get_backfill_complete(&db, inbox.id).unwrap());
    let headers = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
    for h in &headers {
        assert!(service::get_or_fetch_body(&db, h.id, creds.as_ref()).await.unwrap().text_plain.is_some());
    }

    let resynced = service::incremental_sync_folder(&db, account.id, inbox.id, creds.as_ref(), &sink)
        .await
        .expect("incremental sync failed");
    assert_eq!(resynced, 0, "re-syncing with no new mail reports zero new messages");
    let after = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
    assert!(after.iter().all(|h| !h.seen), "prefetch must not mark messages seen");

    am_storage::settings_repo::set_setting(&db, &format!("prefetch.bodies.{}", account.id), "false").unwrap();
    assert!(!service::run_prefetch_batch(&db, account.id, creds.as_ref(), &sink).await.unwrap());
}

async fn seed_many_folders(port: u16) {
    let mut session = open_seed_session(port).await;

    session
        .append("INBOX", None, None, raw_message(SUBJECT_ONE, BODY_ONE).as_bytes())
        .await
        .expect("append to inbox failed");

    for name in ["Projects", "Invoices", "Newsletters", "Travel"] {
        session.create(name).await.ok();
        session
            .append(name, None, None, raw_message(name, "folder seed marker").as_bytes())
            .await
            .unwrap_or_else(|_| panic!("append to {name} failed"));
    }

    session.logout().await.expect("seed logout failed");
}

struct CountingCreds {
    inner: std::sync::Arc<am_sync::auth::KeychainCredentialSource>,
    fetches: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait::async_trait]
impl am_sync::auth::CredentialSource for CountingCreds {
    async fn auth_for(
        &self,
        account: &am_core::account::Account,
    ) -> Result<am_sync::auth::AccountAuth, service::SyncError> {
        self.fetches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.auth_for(account).await
    }
}

#[tokio::test]
async fn concurrent_body_requests_hit_the_server_once() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail concurrency integration test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image.start().await.expect("failed to start greenmail container");
    let mapped_port = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    tokio::time::sleep(Duration::from_millis(500)).await;
    seed_inbox_only(mapped_port).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };
    let db = std::sync::Arc::new(Database::open_in_memory().expect("db open failed"));
    let account = service::add_account(&db, AddAccountInput {
        email: USER.to_string(),
        display_name: "Sync User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    }).await.expect("add_account failed");

    let inbox = folders_repo::find_by_type(&db, account.id, FolderType::Inbox)
        .unwrap()
        .expect("inbox folder missing");
    let headers = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
    let target = headers[0].id;

    let fetches = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let creds: std::sync::Arc<dyn am_sync::auth::CredentialSource> = std::sync::Arc::new(CountingCreds {
        inner: am_sync::auth::KeychainCredentialSource::new(),
        fetches: std::sync::Arc::clone(&fetches),
    });

    let mut tasks = Vec::new();
    for _ in 0..3 {
        let db = std::sync::Arc::clone(&db);
        let creds = std::sync::Arc::clone(&creds);
        tasks.push(tokio::spawn(async move {
            service::get_or_fetch_body(&db, target, creds.as_ref()).await
        }));
    }

    let mut bodies = Vec::new();
    for task in tasks {
        bodies.push(task.await.expect("task panicked").expect("get_or_fetch_body failed"));
    }

    assert!(bodies[0].text_plain.is_some(), "body should have been fetched");
    assert!(bodies.iter().all(|b| *b == bodies[0]), "all callers must observe the same body");
    assert_eq!(
        fetches.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "concurrent requests for one message must perform a single network fetch"
    );
}

#[tokio::test]
async fn full_scan_reuses_one_session_for_all_folders() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail full scan integration test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image.start().await.expect("failed to start greenmail container");
    let mapped_port = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    tokio::time::sleep(Duration::from_millis(500)).await;
    seed_many_folders(mapped_port).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };
    let db = Database::open_in_memory().expect("db open failed");
    let account = service::add_account(&db, AddAccountInput {
        email: USER.to_string(),
        display_name: "Sync User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    }).await.expect("add_account failed");

    let folders = folders_repo::list_folders(&db, account.id).expect("list_folders failed");
    let non_inbox = folders
        .iter()
        .filter(|f| !f.remote_path.eq_ignore_ascii_case("INBOX"))
        .count();
    assert!(non_inbox >= 4, "expected at least 4 non-inbox folders, got {non_inbox}");

    let fetches = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let creds = CountingCreds {
        inner: am_sync::auth::KeychainCredentialSource::new(),
        fetches: std::sync::Arc::clone(&fetches),
    };
    let sink = am_sync::events::NoopSink;

    service::full_scan_account(&db, account.id, &creds, &sink)
        .await
        .expect("full_scan_account failed");

    assert_eq!(
        fetches.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "a full scan must authenticate once, not once per folder"
    );
}

#[tokio::test]
async fn initial_sync_authenticates_once_for_all_folders() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail initial sync integration test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image.start().await.expect("failed to start greenmail container");
    let mapped_port = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    tokio::time::sleep(Duration::from_millis(500)).await;
    seed_many_folders(mapped_port).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };
    let db = Database::open_in_memory().expect("db open failed");
    let account = service::add_account(&db, AddAccountInput {
        email: USER.to_string(),
        display_name: "Sync User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    }).await.expect("add_account failed");

    let folder_count = folders_repo::list_folders(&db, account.id).expect("list_folders failed").len();
    assert!(folder_count >= 5, "expected at least 5 folders, got {folder_count}");

    let fetches = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let creds = CountingCreds {
        inner: am_sync::auth::KeychainCredentialSource::new(),
        fetches: std::sync::Arc::clone(&fetches),
    };

    service::sync_all_folders(&db, account.id, &creds, |_| {})
        .await
        .expect("sync_all_folders failed");

    let logins = fetches.load(std::sync::atomic::Ordering::SeqCst);
    assert!(
        logins <= 2,
        "syncing {folder_count} folders must not authenticate once per folder, got {logins} logins"
    );
}

#[tokio::test]
async fn idle_returns_changed_immediately_for_mail_arrived_before_idle() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail idle-skip integration test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image
        .start()
        .await
        .expect("failed to start greenmail container");

    let mapped_port = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    tokio::time::sleep(Duration::from_millis(500)).await;

    seed_inbox_only(mapped_port).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };

    let db = Database::open_in_memory().expect("db open failed");

    let account = service::add_account(&db, AddAccountInput {
        email: USER.to_string(),
        display_name: "Sync User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    }).await.expect("add_account failed");

    let inbox = folders_repo::find_by_type(&db, account.id, FolderType::Inbox)
        .unwrap()
        .expect("inbox folder missing");

    let mut session = open_seed_session(mapped_port).await;
    session
        .append("INBOX", None, None, raw_message("Late Arrival", "late marker OMEGA").as_bytes())
        .await
        .expect("append of late message failed");
    session.logout().await.ok();

    let creds = am_sync::auth::KeychainCredentialSource::new();
    let token = tokio_util::sync::CancellationToken::new();
    let notify = std::sync::Arc::new(tokio::sync::Notify::new());

    let outcome = tokio::time::timeout(
        Duration::from_secs(20),
        am_sync::engine::idle_inbox(
            &db,
            account.id,
            inbox.id,
            "INBOX",
            creds.as_ref(),
            true,
            Duration::from_secs(120),
            token,
            notify,
        ),
    )
    .await
    .expect("idle_inbox must return promptly when mail already arrived before idle started");

    assert!(
        matches!(outcome, Ok(am_sync::engine::IdleOutcomeKind::Changed)),
        "expected Changed for mail that arrived before idle, got {outcome:?}"
    );
}
