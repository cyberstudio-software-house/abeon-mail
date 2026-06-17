use std::process::Command;
use std::time::Duration;

use am_protocols::error::ProtocolError;
use am_protocols::imap::{ImapConfig, ImapSession};
use async_imap::Client;
use testcontainers::core::{ContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};
use tokio::net::TcpStream;

const IMAP_PORT: u16 = 3143;
const USER: &str = "test@localhost";
const PASSWORD: &str = "test";

const SUBJECT_ONE: &str = "AbeonMail Integration One";
const BODY_ONE: &str = "First seeded message body marker ALPHA";
const SUBJECT_TWO: &str = "AbeonMail Integration Two";
const BODY_TWO: &str = "Second seeded message body marker BETA";

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

async fn seed_messages(port: u16) -> Result<(), ProtocolError> {
    let tcp = TcpStream::connect(("127.0.0.1", port)).await?;
    let client = Client::new(tcp);
    let mut session = client
        .login(USER, PASSWORD)
        .await
        .map_err(|(_, _)| ProtocolError::Auth)?;

    session
        .append(
            "INBOX",
            None,
            None,
            raw_message(SUBJECT_ONE, BODY_ONE).as_bytes(),
        )
        .await?;
    session
        .append(
            "INBOX",
            None,
            None,
            raw_message(SUBJECT_TWO, BODY_TWO).as_bytes(),
        )
        .await?;

    session.logout().await?;
    Ok(())
}

#[tokio::test]
async fn greenmail_end_to_end() {
    if !docker_available() {
        eprintln!("docker is not available; skipping greenmail integration test");
        return;
    }

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

    seed_messages(mapped_port)
        .await
        .expect("failed to seed messages");

    let config = ImapConfig {
        host: "127.0.0.1".to_string(),
        port: mapped_port,
        tls: false,
        username: USER.to_string(),
    };

    let mut session = ImapSession::connect(&config, PASSWORD)
        .await
        .expect("connect failed");

    let folders = session.list_folders().await.expect("list_folders failed");
    assert!(
        folders
            .iter()
            .any(|f| f.remote_path.eq_ignore_ascii_case("INBOX")),
        "INBOX not found in folders: {folders:?}"
    );

    let state = session.select("INBOX").await.expect("select failed");
    assert!(
        state.exists >= 2,
        "expected at least 2 messages, got {}",
        state.exists
    );

    let headers = session
        .fetch_recent_headers(10)
        .await
        .expect("fetch_recent_headers failed");
    assert!(headers.len() >= 2, "expected at least 2 headers");

    let subjects: Vec<&str> = headers.iter().map(|h| h.subject.as_str()).collect();
    assert!(
        subjects.contains(&SUBJECT_ONE),
        "subject one missing: {subjects:?}"
    );
    assert!(
        subjects.contains(&SUBJECT_TWO),
        "subject two missing: {subjects:?}"
    );

    let header_one = headers
        .iter()
        .find(|h| h.subject == SUBJECT_ONE)
        .expect("header one not found");
    assert_eq!(header_one.from_address, "sender@example.com");

    let body = session
        .fetch_body(header_one.uid)
        .await
        .expect("fetch_body failed");
    let body_text = String::from_utf8_lossy(&body);
    assert!(
        body_text.contains(BODY_ONE),
        "body did not contain expected marker"
    );

    session.logout().await.expect("logout failed");
}
