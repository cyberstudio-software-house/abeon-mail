use am_auth::endpoints::Endpoints;
use am_core::account::{Account, NewAccount, ProviderType};
use am_core::folder::FolderType;
use am_core::message::{MessageBody, NewMessageHeader, SyncProgress};
use am_protocols::imap::{FetchedHeader, ImapConfig, ImapSession, RemoteFolder};
use am_storage::{accounts_repo, folders_repo, messages_repo, Database, StorageError};
use crate::events::{SyncEvent, SyncEventSink};

const INITIAL_SYNC_LIMIT: u32 = 200;
const INBOX_PATH: &str = "INBOX";

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct AddAccountInput {
    pub email: String,
    pub display_name: String,
    pub password: String,
    pub endpoints: Endpoints,
}

impl std::fmt::Debug for AddAccountInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddAccountInput")
            .field("email", &self.email)
            .field("display_name", &self.display_name)
            .field("password", &"***")
            .field("endpoints", &self.endpoints)
            .finish()
    }
}

#[derive(thiserror::Error, Debug)]
pub enum SyncError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("authentication failed")]
    Auth,
    #[error("credential not found")]
    CredentialMissing,
    #[error("invalid account settings")]
    InvalidSettings,
    #[error("keychain unavailable")]
    Keychain,
}

impl From<am_protocols::error::ProtocolError> for SyncError {
    fn from(e: am_protocols::error::ProtocolError) -> Self {
        match e {
            am_protocols::error::ProtocolError::Auth => SyncError::Auth,
            other => SyncError::Protocol(other.to_string()),
        }
    }
}

impl From<am_auth::AuthError> for SyncError {
    fn from(e: am_auth::AuthError) -> Self {
        match e {
            am_auth::AuthError::NotFound => SyncError::CredentialMissing,
            am_auth::AuthError::Keychain(_) => SyncError::Keychain,
        }
    }
}

fn folder_type_for(remote_path: &str, special_use: Option<&str>) -> FolderType {
    if remote_path.eq_ignore_ascii_case(INBOX_PATH) {
        return FolderType::Inbox;
    }
    match special_use {
        Some("\\Sent") => FolderType::Sent,
        Some("\\Drafts") => FolderType::Drafts,
        Some("\\Trash") => FolderType::Trash,
        Some("\\Junk") => FolderType::Spam,
        Some("\\Archive") => FolderType::Archive,
        _ => FolderType::Custom,
    }
}

fn imap_config(endpoints: &Endpoints, username: &str) -> ImapConfig {
    ImapConfig {
        host: endpoints.imap_host.clone(),
        port: endpoints.imap_port,
        tls: endpoints.imap_tls,
        username: username.to_string(),
    }
}

fn header_from_fetch(fetched: &FetchedHeader) -> NewMessageHeader {
    NewMessageHeader {
        uid: fetched.uid,
        message_id_hdr: fetched.message_id_hdr.clone(),
        in_reply_to: fetched.in_reply_to.clone(),
        references_hdr: if fetched.references.is_empty() {
            None
        } else {
            Some(fetched.references.join(" "))
        },
        from_address: fetched.from_address.clone(),
        from_name: fetched.from_name.clone(),
        subject: fetched.subject.clone(),
        date: fetched.date,
        seen: fetched.seen,
        flagged: fetched.flagged,
        has_attachments: false,
        size: fetched.size,
        snippet: String::new(),
    }
}

fn load_endpoints(db: &Database, account_id: i64) -> Result<Endpoints, SyncError> {
    let settings = accounts_repo::get_account_settings(db, account_id)?;
    serde_json::from_str(&settings).map_err(|_| SyncError::InvalidSettings)
}

fn upsert_remote_folders(
    db: &Database,
    account_id: i64,
    folders: &[RemoteFolder],
) -> Result<(), SyncError> {
    for folder in folders {
        let folder_type = folder_type_for(&folder.remote_path, folder.special_use.as_deref());
        folders_repo::upsert_folder(
            db,
            account_id,
            &folder.remote_path,
            &folder.name,
            folder_type,
        )?;
    }
    Ok(())
}

pub async fn add_account(db: &Database, input: AddAccountInput) -> Result<Account, SyncError> {
    am_auth::credentials::store_password(&input.email, &input.password)?;

    let settings = serde_json::to_string(&input.endpoints).map_err(|_| SyncError::InvalidSettings)?;
    let new_account = NewAccount {
        email: input.email.clone(),
        display_name: input.display_name.clone(),
        provider_type: ProviderType::ImapPassword,
        color: None,
    };
    let account =
        accounts_repo::insert_account_with_settings(db, &new_account, &input.email, &settings)?;

    let config = imap_config(&input.endpoints, &input.email);
    let mut session = ImapSession::connect(&config, &input.password).await?;
    let folders = session.list_folders().await?;
    session.logout().await?;

    upsert_remote_folders(db, account.id, &folders)?;

    sync_all_folders(db, account.id, |_| {}).await?;

    Ok(account)
}

pub async fn sync_folder(
    db: &Database,
    account_id: i64,
    folder_id: i64,
    progress: impl Fn(SyncProgress),
) -> Result<usize, SyncError> {
    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;
    let folder = folders_repo::get_folder(db, folder_id)?;

    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await?;
    let state = session.select(&folder.remote_path).await?;
    let fetched = session.fetch_recent_headers(INITIAL_SYNC_LIMIT).await?;
    session.logout().await?;

    let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
    let inserted = messages_repo::insert_headers(db, folder.id, &headers)?;

    folders_repo::set_sync_markers(db, folder.id, state.uidvalidity, state.uidnext, None, now_secs())?;
    let unread = fetched.iter().filter(|h| !h.seen).count() as i64;
    folders_repo::set_counts(db, folder.id, unread, state.exists)?;

    progress(SyncProgress {
        account_id,
        folder_id: folder.id,
        fetched: fetched.len() as i64,
        total: state.exists,
    });

    Ok(inserted)
}

pub async fn initial_sync_inbox(
    db: &Database,
    account_id: i64,
    progress: impl Fn(SyncProgress),
) -> Result<usize, SyncError> {
    let folder = folders_repo::list_folders(db, account_id)?
        .into_iter()
        .find(|f| f.remote_path.eq_ignore_ascii_case(INBOX_PATH))
        .ok_or(SyncError::Storage(StorageError::NotFound))?;
    sync_folder(db, account_id, folder.id, progress).await
}

pub async fn sync_all_folders(
    db: &Database,
    account_id: i64,
    progress: impl Fn(SyncProgress) + Copy,
) -> Result<usize, SyncError> {
    let folders = folders_repo::list_folders(db, account_id)?;
    let mut total = 0usize;
    for folder in folders {
        total += sync_folder(db, account_id, folder.id, progress).await?;
    }
    Ok(total)
}

pub async fn get_or_fetch_body(db: &Database, message_id: i64) -> Result<MessageBody, SyncError> {
    if let Some(body) = messages_repo::get_body(db, message_id)? {
        return Ok(body);
    }

    let (folder_id, uid) = messages_repo::message_uid(db, message_id)?;
    let folder = folders_repo::get_folder(db, folder_id)?;
    let account = accounts_repo::get_account(db, folder.account_id)?;
    let endpoints = load_endpoints(db, folder.account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;

    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await?;
    session.select(&folder.remote_path).await?;
    let raw = session.fetch_body(uid).await?;
    session.logout().await?;

    let parsed = am_mime::parse::parse_message(&raw);
    let body = MessageBody {
        message_id,
        text_plain: parsed.text_plain,
        text_html: parsed.text_html,
    };
    messages_repo::store_body(db, message_id, &body)?;
    messages_repo::backfill_body_meta(
        db,
        message_id,
        &parsed.snippet,
        !parsed.attachment_names.is_empty(),
    )?;
    am_storage::attachments_repo::replace_for_message(db, message_id, &parsed.attachment_names)?;
    Ok(body)
}

pub async fn incremental_sync_folder(
    db: &Database,
    account_id: i64,
    folder_id: i64,
    sink: &dyn SyncEventSink,
) -> Result<(), SyncError> {
    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;
    let folder = folders_repo::get_folder(db, folder_id)?;

    let config = imap_config(&endpoints, &account.email);
    let mut session = ImapSession::connect(&config, &password).await?;
    let state = session.select(&folder.remote_path).await?;
    let markers = folders_repo::get_sync_markers(db, folder_id)?;

    if markers.uidvalidity != Some(state.uidvalidity) {
        messages_repo::delete_by_folder(db, folder_id)?;
        let fetched = session.fetch_recent_headers(INITIAL_SYNC_LIMIT).await?;
        session.logout().await?;
        let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
        messages_repo::insert_headers(db, folder_id, &headers)?;
        folders_repo::set_sync_markers(db, folder_id, state.uidvalidity, state.uidnext, state.highestmodseq, now_secs())?;
        let unread = folders_repo::recount_unread(db, folder_id)?;
        folders_repo::set_counts(db, folder_id, unread, state.exists)?;
        sink.emit(SyncEvent::MailboxChanged { account_id, folder_id });
        return Ok(());
    }

    let caps = session.server_caps().await?;
    let since_uid = markers.uidnext.unwrap_or(1);
    let new_uids = session.search_new_uids(since_uid).await?;
    let new_count = new_uids.len() as i64;
    if !new_uids.is_empty() {
        let fetched = session.fetch_headers_by_uids(&new_uids).await?;
        let headers: Vec<NewMessageHeader> = fetched.iter().map(header_from_fetch).collect();
        messages_repo::insert_headers(db, folder_id, &headers)?;
    }

    if let Some(modseq) = markers.highestmodseq.filter(|_| caps.condstore) {
        let changes = session.fetch_flag_changes(modseq).await?;
        for c in changes {
            messages_repo::set_flags_by_uid(db, folder_id, c.uid, c.seen, c.flagged)?;
        }
    } else {
        let flags = session.fetch_all_flags().await?;
        for c in flags {
            messages_repo::set_flags_by_uid(db, folder_id, c.uid, c.seen, c.flagged)?;
        }
        let server_uids = session.search_all_uids().await?;
        let server_set: std::collections::HashSet<i64> = server_uids.into_iter().collect();
        let local = messages_repo::list_uids(db, folder_id)?;
        let vanished: Vec<i64> = local.into_iter().filter(|u| !server_set.contains(u)).collect();
        if !vanished.is_empty() {
            messages_repo::delete_by_uids(db, folder_id, &vanished)?;
        }
    }

    session.logout().await?;

    folders_repo::set_sync_markers(db, folder_id, state.uidvalidity, state.uidnext, state.highestmodseq, now_secs())?;
    let unread = folders_repo::recount_unread(db, folder_id)?;
    folders_repo::set_counts(db, folder_id, unread, state.exists)?;

    if new_count > 0 {
        sink.emit(SyncEvent::NewMessages { account_id, folder_id, count: new_count });
    }
    sink.emit(SyncEvent::MailboxChanged { account_id, folder_id });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_type_mapping_covers_special_use() {
        assert_eq!(folder_type_for("INBOX", None), FolderType::Inbox);
        assert_eq!(folder_type_for("inbox", None), FolderType::Inbox);
        assert_eq!(folder_type_for("Sent", Some("\\Sent")), FolderType::Sent);
        assert_eq!(folder_type_for("Drafts", Some("\\Drafts")), FolderType::Drafts);
        assert_eq!(folder_type_for("Trash", Some("\\Trash")), FolderType::Trash);
        assert_eq!(folder_type_for("Junk", Some("\\Junk")), FolderType::Spam);
        assert_eq!(folder_type_for("Archive", Some("\\Archive")), FolderType::Archive);
        assert_eq!(folder_type_for("Work", None), FolderType::Custom);
        assert_eq!(folder_type_for("All", Some("\\All")), FolderType::Custom);
    }

    #[test]
    fn header_from_fetch_clears_snippet_and_attachments() {
        let fetched = FetchedHeader {
            uid: 7,
            message_id_hdr: Some("<id@example.com>".into()),
            from_address: "a@b.com".into(),
            from_name: Some("A".into()),
            subject: "Hi".into(),
            date: 123,
            seen: true,
            flagged: false,
            size: 42,
            in_reply_to: None,
            references: vec![],
        };
        let header = header_from_fetch(&fetched);
        assert_eq!(header.uid, 7);
        assert_eq!(header.subject, "Hi");
        assert_eq!(header.size, 42);
        assert!(header.seen);
        assert_eq!(header.snippet, "");
        assert!(!header.has_attachments);
    }

    #[test]
    fn header_from_fetch_joins_references_and_copies_in_reply_to() {
        let fetched = FetchedHeader {
            uid: 8,
            message_id_hdr: Some("<id@example.com>".into()),
            from_address: "a@b.com".into(),
            from_name: Some("A".into()),
            subject: "Hi".into(),
            date: 123,
            seen: false,
            flagged: false,
            size: 10,
            in_reply_to: Some("<parent@example.com>".into()),
            references: vec!["<a@x>".into(), "<b@y>".into()],
        };
        let header = header_from_fetch(&fetched);
        assert_eq!(header.in_reply_to.as_deref(), Some("<parent@example.com>"));
        assert_eq!(header.references_hdr.as_deref(), Some("<a@x> <b@y>"));
    }

    #[test]
    fn sync_error_never_contains_password() {
        let err = SyncError::Auth;
        assert_eq!(err.to_string(), "authentication failed");
    }
}
