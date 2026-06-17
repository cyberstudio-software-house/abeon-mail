use std::any::Any;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, Once};
use std::time::Duration;

use am_auth::endpoints::Endpoints;
use am_core::folder::FolderType;
use am_core::outgoing::OutgoingMessage;
use am_storage::{folders_repo, messages_repo, queue_repo, Database};
use am_sync::send::{drain_outbox, enqueue_send};
use am_sync::service::{add_account, now_secs, sync_folder, AddAccountInput};
use async_imap::Client;
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence};
use testcontainers::core::{ContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};
use tokio::net::TcpStream;

const IMAP_PORT: u16 = 3143;
const SMTP_PORT: u16 = 3025;
const USER: &str = "send-user@localhost";
const PASSWORD: &str = "send-secret";
const RCPT: &str = "rcpt@localhost";
const SENT_MAILBOX: &str = "Sent";
const SEND_SUBJECT: &str = "GreenMail Send E2E Test Subject";

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

async fn create_sent_mailbox(imap_port: u16) {
    let tcp = TcpStream::connect(("127.0.0.1", imap_port))
        .await
        .expect("connect for mailbox creation failed");
    let client = Client::new(tcp);
    let mut session = client
        .login(USER, PASSWORD)
        .await
        .map_err(|(e, _)| e)
        .expect("login for mailbox creation failed");
    session.create(SENT_MAILBOX).await.ok();
    session
        .logout()
        .await
        .expect("logout after mailbox creation failed");
}

#[tokio::test]
async fn enqueue_and_drain_sends_and_appends_to_sent() {
    if !docker_available() {
        eprintln!("docker not available; skipping send greenmail e2e test");
        return;
    }

    install_in_mem_builder();

    let image = GenericImage::new("greenmail/standalone", "latest")
        .with_wait_for(WaitFor::message_on_stdout("Starting GreenMail standalone"))
        .with_exposed_port(ContainerPort::Tcp(IMAP_PORT))
        .with_exposed_port(ContainerPort::Tcp(SMTP_PORT))
        .with_env_var(
            "GREENMAIL_OPTS",
            "-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.verbose -Dgreenmail.hostname=0.0.0.0",
        );

    let container = image
        .start()
        .await
        .expect("failed to start greenmail container");

    let mapped_imap = container
        .get_host_port_ipv4(ContainerPort::Tcp(IMAP_PORT))
        .await
        .expect("failed to get mapped imap port");

    let mapped_smtp = container
        .get_host_port_ipv4(ContainerPort::Tcp(SMTP_PORT))
        .await
        .expect("failed to get mapped smtp port");

    tokio::time::sleep(Duration::from_millis(500)).await;

    create_sent_mailbox(mapped_imap).await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_imap,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: mapped_smtp,
        smtp_tls: false,
    };

    let db = Database::open_in_memory().expect("db open failed");

    let input = AddAccountInput {
        email: USER.to_string(),
        display_name: "Send User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    };

    let account = add_account(&db, input).await.expect("add_account failed");

    let sent_folder =
        folders_repo::upsert_folder(&db, account.id, SENT_MAILBOX, "Sent", FolderType::Sent)
            .expect("upsert_folder Sent failed");

    let msg = OutgoingMessage {
        from_address: USER.to_string(),
        from_name: Some("Send User".to_string()),
        to: vec![RCPT.to_string()],
        cc: vec![],
        bcc: vec![],
        subject: SEND_SUBJECT.to_string(),
        text_body: "Hello from e2e test".to_string(),
        html_body: Some("<p>Hello from e2e test</p>".to_string()),
        in_reply_to: None,
        references: vec![],
        attachments: vec![],
    };

    let draft_id = am_storage::drafts_repo::save_draft(&db, account.id, None, &msg)
        .expect("save_draft failed");

    enqueue_send(&db, draft_id).expect("enqueue_send failed");

    let queue_before = queue_repo::list_due(&db, account.id, now_secs()).expect("list_due failed");
    assert_eq!(queue_before.len(), 1, "expected 1 queued op before drain");

    drain_outbox(&db, account.id, now_secs())
        .await
        .expect("drain_outbox failed");

    let queue_after =
        queue_repo::list_due(&db, account.id, now_secs()).expect("list_due after failed");
    assert!(
        queue_after.is_empty(),
        "queue should be empty after drain, got: {queue_after:?}"
    );

    let draft_ids =
        am_storage::drafts_repo::list_draft_ids(&db, account.id).expect("list_draft_ids failed");
    assert!(
        draft_ids.is_empty(),
        "draft should be deleted after send, got ids: {draft_ids:?}"
    );

    sync_folder(&db, account.id, sent_folder.id, |_| {})
        .await
        .expect("sync Sent folder failed");

    let sent_messages = messages_repo::list_by_folder(&db, sent_folder.id, 50, 0)
        .expect("list_by_folder Sent failed");

    assert!(
        !sent_messages.is_empty(),
        "Sent folder should have at least one message after send"
    );
    assert!(
        sent_messages.iter().any(|m| m.subject == SEND_SUBJECT),
        "Sent folder should contain the sent message subject '{SEND_SUBJECT}', got: {:?}",
        sent_messages.iter().map(|m| &m.subject).collect::<Vec<_>>()
    );
}
