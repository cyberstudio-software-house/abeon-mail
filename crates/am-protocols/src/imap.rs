use std::sync::Arc;

use async_imap::types::{Fetch, Flag, Name, NameAttribute};
use async_imap::{Client, Session};
use futures::TryStreamExt;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use crate::error::ProtocolError;

#[derive(Debug, Clone)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedHeader {
    pub uid: i64,
    pub message_id_hdr: Option<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFolder {
    pub remote_path: String,
    pub name: String,
    pub special_use: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MailboxState {
    pub uidvalidity: i64,
    pub uidnext: i64,
    pub exists: i64,
}

enum SessionStream {
    Plain(Box<Session<TcpStream>>),
    Tls(Box<Session<TlsStream<TcpStream>>>),
}

pub struct ImapSession {
    session: SessionStream,
}

impl std::fmt::Debug for ImapSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImapSession").finish_non_exhaustive()
    }
}

impl ImapSession {
    pub async fn connect(
        config: &ImapConfig,
        password: &str,
    ) -> Result<ImapSession, ProtocolError> {
        let tcp = TcpStream::connect((config.host.as_str(), config.port))
            .await
            .map_err(|e| ProtocolError::Connect(e.to_string()))?;

        if config.tls {
            let connector = build_tls_connector()?;
            let domain = ServerName::try_from(config.host.clone())
                .map_err(|e| ProtocolError::Tls(e.to_string()))?;
            let tls_stream = connector
                .connect(domain, tcp)
                .await
                .map_err(|e| ProtocolError::Tls(e.to_string()))?;
            let client = Client::new(tls_stream);
            let session = login(client, &config.username, password).await?;
            Ok(ImapSession {
                session: SessionStream::Tls(Box::new(session)),
            })
        } else {
            let client = Client::new(tcp);
            let session = login(client, &config.username, password).await?;
            Ok(ImapSession {
                session: SessionStream::Plain(Box::new(session)),
            })
        }
    }

    pub async fn list_folders(&mut self) -> Result<Vec<RemoteFolder>, ProtocolError> {
        let names: Vec<Name> = match &mut self.session {
            SessionStream::Plain(s) => {
                let stream = s.list(None, Some("*")).await?;
                stream.try_collect().await?
            }
            SessionStream::Tls(s) => {
                let stream = s.list(None, Some("*")).await?;
                stream.try_collect().await?
            }
        };
        Ok(names.iter().map(map_folder).collect())
    }

    pub async fn select(&mut self, remote_path: &str) -> Result<MailboxState, ProtocolError> {
        let mailbox = match &mut self.session {
            SessionStream::Plain(s) => s.select(remote_path).await?,
            SessionStream::Tls(s) => s.select(remote_path).await?,
        };
        Ok(MailboxState {
            uidvalidity: mailbox.uid_validity.unwrap_or(0) as i64,
            uidnext: mailbox.uid_next.unwrap_or(0) as i64,
            exists: mailbox.exists as i64,
        })
    }

    pub async fn fetch_recent_headers(
        &mut self,
        limit: u32,
    ) -> Result<Vec<FetchedHeader>, ProtocolError> {
        let exists = match &mut self.session {
            SessionStream::Plain(s) => s.select("INBOX").await?.exists,
            SessionStream::Tls(s) => s.select("INBOX").await?.exists,
        };

        if exists == 0 || limit == 0 {
            return Ok(Vec::new());
        }

        let start = exists.saturating_sub(limit).saturating_add(1).max(1);
        let range = format!("{start}:{exists}");
        let query = "(UID ENVELOPE FLAGS RFC822.SIZE INTERNALDATE)";

        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => {
                let stream = s.fetch(&range, query).await?;
                stream.try_collect().await?
            }
            SessionStream::Tls(s) => {
                let stream = s.fetch(&range, query).await?;
                stream.try_collect().await?
            }
        };

        let mut headers: Vec<FetchedHeader> = fetches.iter().map(map_header).collect();
        headers.sort_by(|a, b| b.uid.cmp(&a.uid));
        Ok(headers)
    }

    pub async fn fetch_body(&mut self, uid: i64) -> Result<Vec<u8>, ProtocolError> {
        let uid_str = uid.to_string();
        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => {
                let stream = s.uid_fetch(&uid_str, "BODY[]").await?;
                stream.try_collect().await?
            }
            SessionStream::Tls(s) => {
                let stream = s.uid_fetch(&uid_str, "BODY[]").await?;
                stream.try_collect().await?
            }
        };

        let body = fetches
            .iter()
            .find_map(|f| f.body())
            .ok_or_else(|| ProtocolError::Protocol(format!("no body for uid {uid}")))?;
        Ok(body.to_vec())
    }

    pub async fn logout(mut self) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => s.logout().await?,
            SessionStream::Tls(s) => s.logout().await?,
        }
        Ok(())
    }
}

async fn login<T>(
    client: Client<T>,
    username: &str,
    password: &str,
) -> Result<Session<T>, ProtocolError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    client
        .login(username, password)
        .await
        .map_err(|(_, _)| ProtocolError::Auth)
}

fn build_tls_connector() -> Result<TlsConnector, ProtocolError> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

fn map_folder(name: &Name) -> RemoteFolder {
    let remote_path = name.name().to_string();
    let delimiter = name.delimiter().unwrap_or("/");
    let leaf = remote_path
        .rsplit(delimiter)
        .next()
        .unwrap_or(&remote_path)
        .to_string();
    let special_use = name.attributes().iter().find_map(special_use_label);
    RemoteFolder {
        remote_path,
        name: leaf,
        special_use,
    }
}

fn special_use_label(attr: &NameAttribute) -> Option<String> {
    match attr {
        NameAttribute::All => Some("\\All".to_string()),
        NameAttribute::Archive => Some("\\Archive".to_string()),
        NameAttribute::Drafts => Some("\\Drafts".to_string()),
        NameAttribute::Flagged => Some("\\Flagged".to_string()),
        NameAttribute::Junk => Some("\\Junk".to_string()),
        NameAttribute::Sent => Some("\\Sent".to_string()),
        NameAttribute::Trash => Some("\\Trash".to_string()),
        _ => None,
    }
}

fn map_header(fetch: &Fetch) -> FetchedHeader {
    let uid = fetch.uid.unwrap_or(0) as i64;
    let size = fetch.size.unwrap_or(0) as i64;

    let mut seen = false;
    let mut flagged = false;
    for flag in fetch.flags() {
        match flag {
            Flag::Seen => seen = true,
            Flag::Flagged => flagged = true,
            _ => {}
        }
    }

    let envelope = fetch.envelope();
    let subject = envelope
        .and_then(|e| e.subject.as_ref())
        .map(|s| decode_bytes(s))
        .unwrap_or_default();
    let message_id_hdr = envelope
        .and_then(|e| e.message_id.as_ref())
        .map(|s| decode_bytes(s));

    let (from_address, from_name) = envelope
        .and_then(|e| e.from.as_ref())
        .and_then(|addrs| addrs.first())
        .map(|addr| {
            let mailbox = addr.mailbox.as_ref().map(|s| decode_bytes(s));
            let host = addr.host.as_ref().map(|s| decode_bytes(s));
            let address = match (mailbox, host) {
                (Some(m), Some(h)) => format!("{m}@{h}"),
                (Some(m), None) => m,
                _ => String::new(),
            };
            let name = addr.name.as_ref().map(|s| decode_bytes(s));
            (address, name)
        })
        .unwrap_or_default();

    let date = fetch
        .internal_date()
        .map(|d| d.timestamp())
        .or_else(|| {
            envelope
                .and_then(|e| e.date.as_ref())
                .and_then(|d| parse_envelope_date(&decode_bytes(d)))
        })
        .unwrap_or(0);

    FetchedHeader {
        uid,
        message_id_hdr,
        from_address,
        from_name,
        subject,
        date,
        seen,
        flagged,
        size,
    }
}

fn decode_bytes(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn parse_envelope_date(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|d| d.timestamp())
}
