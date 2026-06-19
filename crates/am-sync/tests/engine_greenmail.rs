use std::any::Any;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, Once};
use std::time::Duration;

use am_auth::endpoints::Endpoints;
use am_storage::{folders_repo, messages_repo, Database};
use am_sync::service::{self, AddAccountInput};
use async_imap::Client;
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence};
use testcontainers::core::{ContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};
use tokio::net::TcpStream;

const IMAP_PORT: u16 = 3143;
const USER: &str = "engine-user@localhost";
const PASSWORD: &str = "engine-secret";

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

async fn seed_one(port: u16, subject: &str, body: &str) {
    let tcp = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect for seeding failed");
    let client = Client::new(tcp);
    let mut session = client
        .login(USER, PASSWORD)
        .await
        .map_err(|(e, _)| e)
        .expect("seed login failed");
    session
        .append("INBOX", None, None, raw_message(subject, body).as_bytes())
        .await
        .expect("append failed");
    session.logout().await.expect("seed logout failed");
}

#[tokio::test]
async fn engine_picks_up_new_message_via_incremental() {
    if !docker_available() {
        eprintln!("docker not available; skipping engine integration test");
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

    seed_one(mapped_port, "Seed One", "seed body marker ALPHA").await;

    let endpoints = Endpoints {
        imap_host: "127.0.0.1".to_string(),
        imap_port: mapped_port,
        imap_tls: false,
        smtp_host: "127.0.0.1".to_string(),
        smtp_port: 0,
        smtp_tls: false,
    };

    let db = std::sync::Arc::new(Database::open_in_memory().expect("db open failed"));

    let input = AddAccountInput {
        email: USER.to_string(),
        display_name: "Engine User".to_string(),
        password: PASSWORD.to_string(),
        endpoints,
    };

    let account = service::add_account(&db, input)
        .await
        .expect("add_account failed");

    let sink = std::sync::Arc::new(am_sync::events::NoopSink);
    let creds = am_sync::auth::KeychainCredentialSource::new();
    let engine = am_sync::engine::SyncEngine::start(
        std::sync::Arc::clone(&db),
        sink,
        creds as std::sync::Arc<dyn am_sync::auth::CredentialSource>,
    );
    engine.spawn_account(account.id);

    seed_one(mapped_port, "Live One", "live marker OMEGA").await;

    let inbox = folders_repo::list_folders(&db, account.id)
        .unwrap()
        .into_iter()
        .find(|f| f.remote_path.eq_ignore_ascii_case("INBOX"))
        .unwrap();

    let mut found = false;
    for _ in 0..40 {
        let headers = messages_repo::list_by_folder(&db, inbox.id, 50, 0, i64::MAX).unwrap();
        if headers.iter().any(|h| h.subject == "Live One") {
            found = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert!(found, "engine did not pick up the new message");

    engine.shutdown();
}
