use std::sync::Arc;
use std::time::Duration;

use async_imap::types::{Fetch, Flag, Name, NameAttribute};
use async_imap::{Client, Session};
use futures::TryStreamExt;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use crate::error::ProtocolError;

#[derive(Clone)]
pub enum ImapAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}

impl std::fmt::Debug for ImapAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImapAuth::Password(_) => f.write_str("ImapAuth::Password(***)"),
            ImapAuth::XOauth2 { user, .. } => {
                write!(f, "ImapAuth::XOauth2 {{ user: {user:?}, access_token: *** }}")
            }
        }
    }
}

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
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFolder {
    pub remote_path: String,
    pub name: String,
    pub special_use: Option<String>,
    pub delimiter: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MailboxState {
    pub uidvalidity: i64,
    pub uidnext: i64,
    pub exists: i64,
    pub highestmodseq: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerCaps {
    pub condstore: bool,
    pub idle: bool,
    pub qresync: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlagState {
    pub uid: i64,
    pub seen: bool,
    pub flagged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleOutcome {
    Changed,
    TimedOut,
}

enum SessionStream {
    Plain(Box<Session<TcpStream>>),
    Tls(Box<Session<TlsStream<TcpStream>>>),
}

struct Xoauth2Authenticator {
    sasl: String,
    calls: usize,
}

impl Xoauth2Authenticator {
    fn new(user: &str, access_token: &str) -> Self {
        let raw = format!("user={user}\x01auth=Bearer {access_token}\x01\x01");
        Self { sasl: raw, calls: 0 }
    }
}

impl async_imap::Authenticator for Xoauth2Authenticator {
    type Response = String;
    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        self.calls += 1;
        if self.calls == 1 {
            self.sasl.clone()
        } else {
            String::new()
        }
    }
}

pub struct ImapSession {
    session: SessionStream,
    selected_exists: Option<u32>,
}

impl std::fmt::Debug for ImapSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImapSession").finish_non_exhaustive()
    }
}

impl ImapSession {
    pub async fn connect(
        config: &ImapConfig,
        auth: &ImapAuth,
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
            let mut client = Client::new(tls_stream);
            read_greeting(&mut client).await?;
            let session = authenticate(client, &config.username, auth).await?;
            Ok(ImapSession {
                session: SessionStream::Tls(Box::new(session)),
                selected_exists: None,
            })
        } else {
            let mut client = Client::new(tcp);
            read_greeting(&mut client).await?;
            let session = authenticate(client, &config.username, auth).await?;
            Ok(ImapSession {
                session: SessionStream::Plain(Box::new(session)),
                selected_exists: None,
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
        self.selected_exists = Some(mailbox.exists);
        Ok(MailboxState {
            uidvalidity: mailbox.uid_validity.unwrap_or(0) as i64,
            uidnext: mailbox.uid_next.unwrap_or(0) as i64,
            exists: mailbox.exists as i64,
            highestmodseq: mailbox.highest_modseq.map(|v| v as i64),
        })
    }

    pub async fn fetch_recent_headers(
        &mut self,
        limit: u32,
    ) -> Result<Vec<FetchedHeader>, ProtocolError> {
        let exists = self
            .selected_exists
            .ok_or_else(|| ProtocolError::Protocol("no mailbox selected".into()))?;

        if exists == 0 || limit == 0 {
            return Ok(Vec::new());
        }

        let start = exists.saturating_sub(limit).saturating_add(1).max(1);
        let range = format!("{start}:{exists}");
        let query = "(UID ENVELOPE FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (REFERENCES)])";

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

    pub async fn server_caps(&mut self) -> Result<ServerCaps, ProtocolError> {
        let caps = match &mut self.session {
            SessionStream::Plain(s) => s.capabilities().await?,
            SessionStream::Tls(s) => s.capabilities().await?,
        };
        Ok(ServerCaps {
            condstore: caps.has_str("CONDSTORE"),
            idle: caps.has_str("IDLE"),
            qresync: caps.has_str("QRESYNC"),
        })
    }

    pub async fn search_new_uids(&mut self, since_uid: i64) -> Result<Vec<i64>, ProtocolError> {
        let start = since_uid.max(1);
        let query = format!("UID {start}:*");
        let set = match &mut self.session {
            SessionStream::Plain(s) => s.uid_search(&query).await?,
            SessionStream::Tls(s) => s.uid_search(&query).await?,
        };
        let mut uids: Vec<i64> = set.into_iter().map(|u| u as i64).filter(|u| *u >= start).collect();
        uids.sort_unstable();
        Ok(uids)
    }

    pub async fn search_all_uids(&mut self) -> Result<Vec<i64>, ProtocolError> {
        let set = match &mut self.session {
            SessionStream::Plain(s) => s.uid_search("UID 1:*").await?,
            SessionStream::Tls(s) => s.uid_search("UID 1:*").await?,
        };
        let mut uids: Vec<i64> = set.into_iter().map(|u| u as i64).collect();
        uids.sort_unstable();
        Ok(uids)
    }

    pub async fn fetch_headers_by_uids(&mut self, uids: &[i64]) -> Result<Vec<FetchedHeader>, ProtocolError> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let list = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        let query = "(UID ENVELOPE FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (REFERENCES)])";
        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.uid_fetch(&list, query).await?.try_collect().await?,
            SessionStream::Tls(s) => s.uid_fetch(&list, query).await?.try_collect().await?,
        };
        let mut headers: Vec<FetchedHeader> = fetches.iter().map(map_header).collect();
        headers.sort_by(|a, b| b.uid.cmp(&a.uid));
        Ok(headers)
    }

    pub async fn fetch_flag_changes(&mut self, since_modseq: i64) -> Result<Vec<FlagState>, ProtocolError> {
        let query = format!("(UID FLAGS) (CHANGEDSINCE {since_modseq})");
        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.fetch("1:*", &query).await?.try_collect().await?,
            SessionStream::Tls(s) => s.fetch("1:*", &query).await?.try_collect().await?,
        };
        Ok(fetches.iter().map(flag_state).collect())
    }

    pub async fn fetch_all_flags(&mut self) -> Result<Vec<FlagState>, ProtocolError> {
        let fetches: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.fetch("1:*", "(UID FLAGS)").await?.try_collect().await?,
            SessionStream::Tls(s) => s.fetch("1:*", "(UID FLAGS)").await?.try_collect().await?,
        };
        Ok(fetches.iter().map(flag_state).collect())
    }

    pub async fn store_flag(&mut self, uid: i64, flag: &str, value: bool) -> Result<(), ProtocolError> {
        let op = if value { "+FLAGS" } else { "-FLAGS" };
        let query = format!("{op} ({flag})");
        let uid_str = uid.to_string();
        let _: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.uid_store(&uid_str, &query).await?.try_collect().await?,
            SessionStream::Tls(s) => s.uid_store(&uid_str, &query).await?.try_collect().await?,
        };
        Ok(())
    }

    pub async fn append(
        &mut self,
        folder: &str,
        flags: &str,
        bytes: &[u8],
    ) -> Result<(), ProtocolError> {
        let flags_opt = if flags.is_empty() { None } else { Some(flags) };
        match &mut self.session {
            SessionStream::Plain(s) => s.append(folder, flags_opt, None, bytes).await?,
            SessionStream::Tls(s) => s.append(folder, flags_opt, None, bytes).await?,
        }
        Ok(())
    }

    pub async fn delete_uid(&mut self, folder: &str, uid: i64) -> Result<(), ProtocolError> {
        let uid_str = uid.to_string();
        let query = "+FLAGS (\\Deleted)";
        match &mut self.session {
            SessionStream::Plain(s) => {
                s.select(folder).await?;
                let _: Vec<_> = s.uid_store(&uid_str, query).await?.try_collect().await?;
                s.expunge().await?.try_collect::<Vec<_>>().await?;
            }
            SessionStream::Tls(s) => {
                s.select(folder).await?;
                let _: Vec<_> = s.uid_store(&uid_str, query).await?.try_collect().await?;
                s.expunge().await?.try_collect::<Vec<_>>().await?;
            }
        }
        Ok(())
    }

    pub async fn move_uid(&mut self, src_folder: &str, uid: i64, dst_folder: &str) -> Result<(), ProtocolError> {
        let uid_str = uid.to_string();
        let del = "+FLAGS (\\Deleted)";
        match &mut self.session {
            SessionStream::Plain(s) => {
                s.select(src_folder).await?;
                s.uid_copy(&uid_str, dst_folder).await?;
                let _: Vec<_> = s.uid_store(&uid_str, del).await?.try_collect().await?;
                s.expunge().await?.try_collect::<Vec<_>>().await?;
            }
            SessionStream::Tls(s) => {
                s.select(src_folder).await?;
                s.uid_copy(&uid_str, dst_folder).await?;
                let _: Vec<_> = s.uid_store(&uid_str, del).await?.try_collect().await?;
                s.expunge().await?.try_collect::<Vec<_>>().await?;
            }
        }
        Ok(())
    }

    pub async fn create_folder(&mut self, name: &str) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => s.create(name).await?,
            SessionStream::Tls(s) => s.create(name).await?,
        }
        Ok(())
    }

    pub async fn rename_folder(&mut self, old_path: &str, new_path: &str) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => s.rename(old_path, new_path).await?,
            SessionStream::Tls(s) => s.rename(old_path, new_path).await?,
        }
        Ok(())
    }

    pub async fn delete_folder(&mut self, path: &str) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => s.delete(path).await?,
            SessionStream::Tls(s) => s.delete(path).await?,
        }
        Ok(())
    }

    pub async fn mark_all_seen(&mut self) -> Result<(), ProtocolError> {
        let _: Vec<Fetch> = match &mut self.session {
            SessionStream::Plain(s) => s.uid_store("1:*", "+FLAGS.SILENT (\\Seen)").await?.try_collect().await?,
            SessionStream::Tls(s) => s.uid_store("1:*", "+FLAGS.SILENT (\\Seen)").await?.try_collect().await?,
        };
        Ok(())
    }

    pub async fn idle_wait(self, timeout: Duration) -> Result<(ImapSession, IdleOutcome), ProtocolError> {
        match self.session {
            SessionStream::Plain(s) => {
                let mut handle = (*s).idle();
                handle.init().await?;
                let (result, _stop) = handle.wait_with_timeout(timeout);
                let outcome = match result.await {
                    Ok(async_imap::extensions::idle::IdleResponse::NewData(_)) => IdleOutcome::Changed,
                    _ => IdleOutcome::TimedOut,
                };
                let session = handle.done().await?;
                Ok((ImapSession { session: SessionStream::Plain(Box::new(session)), selected_exists: None }, outcome))
            }
            SessionStream::Tls(s) => {
                let mut handle = (*s).idle();
                handle.init().await?;
                let (result, _stop) = handle.wait_with_timeout(timeout);
                let outcome = match result.await {
                    Ok(async_imap::extensions::idle::IdleResponse::NewData(_)) => IdleOutcome::Changed,
                    _ => IdleOutcome::TimedOut,
                };
                let session = handle.done().await?;
                Ok((ImapSession { session: SessionStream::Tls(Box::new(session)), selected_exists: None }, outcome))
            }
        }
    }
}

fn flag_state(fetch: &Fetch) -> FlagState {
    let mut seen = false;
    let mut flagged = false;
    for flag in fetch.flags() {
        match flag {
            Flag::Seen => seen = true,
            Flag::Flagged => flagged = true,
            _ => {}
        }
    }
    FlagState { uid: fetch.uid.unwrap_or(0) as i64, seen, flagged }
}

async fn read_greeting<T>(client: &mut Client<T>) -> Result<(), ProtocolError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    client
        .read_response()
        .await
        .map_err(|e| ProtocolError::Connect(e.to_string()))?
        .ok_or_else(|| ProtocolError::Connect("no server greeting".into()))?;
    Ok(())
}

async fn authenticate<T>(
    client: Client<T>,
    username: &str,
    auth: &ImapAuth,
) -> Result<Session<T>, ProtocolError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    match auth {
        ImapAuth::Password(pw) => client
            .login(username, pw)
            .await
            .map_err(|(_, _)| ProtocolError::Auth),
        ImapAuth::XOauth2 { user, access_token } => {
            let authenticator = Xoauth2Authenticator::new(user, access_token);
            client
                .authenticate("XOAUTH2", authenticator)
                .await
                .map_err(|(_, _)| ProtocolError::Auth)
        }
    }
}

fn build_tls_connector() -> Result<TlsConnector, ProtocolError> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| ProtocolError::Tls(e.to_string()))?
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
        delimiter: delimiter.to_string(),
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

    let in_reply_to = envelope
        .and_then(|e| e.in_reply_to.as_ref())
        .map(|s| decode_bytes(s))
        .filter(|s| !s.trim().is_empty());

    let references = fetch
        .header()
        .map(|h| parse_references(&String::from_utf8_lossy(h)))
        .unwrap_or_default();

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
        in_reply_to,
        references,
    }
}

fn decode_bytes(bytes: &[u8]) -> String {
    am_mime::rfc2047::decode(&String::from_utf8_lossy(bytes))
}

fn parse_references(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = raw;
    while let Some(open) = rest.find('<') {
        let after = &rest[open..];
        if let Some(close) = after.find('>') {
            out.push(after[..=close].to_string());
            rest = &after[close + 1..];
        } else {
            break;
        }
    }
    out
}

fn parse_envelope_date(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|d| d.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn xoauth2_sasl_is_raw_and_encodes_as_expected() {
        let user = "user@gmail.com";
        let token = "ya29.some_token";
        let auth = Xoauth2Authenticator::new(user, token);
        assert_eq!(auth.sasl, "user=user@gmail.com\x01auth=Bearer ya29.some_token\x01\x01");
        assert_eq!(
            STANDARD.encode(auth.sasl.as_bytes()),
            "dXNlcj11c2VyQGdtYWlsLmNvbQFhdXRoPUJlYXJlciB5YTI5LnNvbWVfdG9rZW4BAQ=="
        );
    }

    #[test]
    fn imap_auth_debug_redacts_password() {
        let auth = ImapAuth::Password("secret123".into());
        let debug = format!("{auth:?}");
        assert!(!debug.contains("secret123"));
        assert!(debug.contains("***"));
    }

    #[test]
    fn imap_auth_debug_redacts_token() {
        let auth = ImapAuth::XOauth2 {
            user: "u@g.com".into(),
            access_token: "tok123".into(),
        };
        let debug = format!("{auth:?}");
        assert!(!debug.contains("tok123"));
        assert!(debug.contains("u@g.com"));
    }

    #[test]
    fn tls_config_builds_without_panic() {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let result = ClientConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map(|b| b.with_root_certificates(roots).with_no_client_auth());
        assert!(result.is_ok());
    }

    #[test]
    fn parse_references_extracts_all_ids() {
        let raw = "<a@x.com> <b@y.com>\r\n <c@z.com>";
        assert_eq!(
            parse_references(raw),
            vec!["<a@x.com>".to_string(), "<b@y.com>".to_string(), "<c@z.com>".to_string()]
        );
    }

    #[test]
    fn parse_references_empty_when_none() {
        assert!(parse_references("   ").is_empty());
    }
}
