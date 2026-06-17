use std::sync::Arc;

use am_core::{account::Account, folder::Folder, message::{MessageBody, MessageFlag, MessageHeader}, thread::ThreadSummary};
use am_storage::{accounts_repo, folders_repo, messages_repo};

use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub fn app_health() -> String {
    "ok".to_string()
}

#[tauri::command]
#[specta::specta]
pub fn list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<Account>, String> {
    accounts_repo::list_accounts(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn resolve_endpoints(email: String) -> am_auth::endpoints::Endpoints {
    am_auth::endpoints::resolve(&email)
}

#[tauri::command]
#[specta::specta]
pub async fn add_account(
    state: tauri::State<'_, AppState>,
    email: String,
    display_name: String,
    password: String,
    endpoints: am_auth::endpoints::Endpoints,
) -> Result<Account, String> {
    let db: Arc<am_storage::Database> = Arc::clone(&state.db);
    let input = am_sync::service::AddAccountInput { email, display_name, password, endpoints };
    let account = am_sync::service::add_account(&db, input).await.map_err(|e| match e {
        am_sync::service::SyncError::Auth => "Authentication failed".to_string(),
        am_sync::service::SyncError::CredentialMissing => "Credential not found".to_string(),
        am_sync::service::SyncError::Keychain => "Keychain unavailable".to_string(),
        _ => "Account setup failed".to_string(),
    })?;
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.spawn_account(account.id);
    }
    Ok(account)
}

#[tauri::command]
#[specta::specta]
pub fn list_folders(state: tauri::State<'_, AppState>, account_id: i64) -> Result<Vec<Folder>, String> {
    folders_repo::list_folders(&state.db, account_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_messages(
    state: tauri::State<'_, AppState>,
    folder_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<MessageHeader>, String> {
    messages_repo::list_by_folder(&state.db, folder_id, limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_message_body(
    state: tauri::State<'_, AppState>,
    message_id: i64,
) -> Result<MessageBody, String> {
    let db: Arc<am_storage::Database> = Arc::clone(&state.db);
    am_sync::service::get_or_fetch_body(&db, message_id)
        .await
        .map_err(|_| "Failed to fetch message body".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn sanitize_message_html(html: String) -> am_mime::sanitize::SanitizedHtml {
    am_mime::sanitize::sanitize_html(&html)
}

#[tauri::command]
#[specta::specta]
pub fn set_message_flags(
    state: tauri::State<'_, AppState>,
    message_id: i64,
    flag: MessageFlag,
    value: bool,
) -> Result<(), String> {
    am_sync::service::enqueue_flag(&state.db, message_id, flag, value)
        .map_err(|_| "Failed to set flag".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_threads(
    state: tauri::State<'_, AppState>,
    folder_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<ThreadSummary>, String> {
    am_storage::threads_repo::list_for_folder(&state.db, folder_id, limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_thread_messages(
    state: tauri::State<'_, AppState>,
    thread_id: i64,
) -> Result<Vec<MessageHeader>, String> {
    messages_repo::list_by_thread(&state.db, thread_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn mark_message_seen(
    state: tauri::State<'_, AppState>,
    message_id: i64,
) -> Result<(), String> {
    am_sync::service::enqueue_flag(&state.db, message_id, MessageFlag::Seen, true)
        .map_err(|_| "Failed to mark seen".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn enqueue_send(state: tauri::State<'_, AppState>, draft_id: i64) -> Result<(), String> {
    am_sync::send::enqueue_send(&state.db, draft_id).map_err(|_| "Failed to enqueue send".to_string())
}

#[cfg(test)]
mod tests {
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::{MessageBody, NewMessageHeader};
    use am_storage::{accounts_repo, folders_repo, messages_repo, Database};

    #[test]
    fn add_account_persists_via_repo() {
        let db = Database::open_in_memory().unwrap();
        let new = NewAccount {
            email: "x@example.com".into(),
            display_name: "X".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        };
        let created = accounts_repo::insert_account(&db, &new).unwrap();
        let all = accounts_repo::list_accounts(&db).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(created.email, "x@example.com");
        assert!(created.id > 0);
        assert_eq!(created.position, 0);
    }

    #[test]
    fn resolve_endpoints_gmail() {
        let ep = super::resolve_endpoints("user@gmail.com".to_string());
        assert_eq!(ep.imap_host, "imap.gmail.com");
        assert_eq!(ep.imap_port, 993);
        assert!(ep.imap_tls);
    }

    #[test]
    fn list_messages_from_seeded_db() {
        let db = Database::open_in_memory().unwrap();
        let account = accounts_repo::insert_account(&db, &NewAccount {
            email: "t@example.com".into(),
            display_name: "T".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let folder = folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        messages_repo::insert_headers(&db, folder.id, &[NewMessageHeader {
            uid: 1,
            message_id_hdr: None,
            in_reply_to: None,
            references_hdr: None,
            from_address: "a@b.com".into(),
            from_name: None,
            subject: "Hello".into(),
            date: 1000,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 100,
            snippet: "".into(),
        }]).unwrap();

        let msgs = messages_repo::list_by_folder(&db, folder.id, 10, 0).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].subject, "Hello");
    }

    #[test]
    fn get_body_from_seeded_db() {
        let db = Database::open_in_memory().unwrap();
        let account = accounts_repo::insert_account(&db, &NewAccount {
            email: "t@example.com".into(),
            display_name: "T".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let folder = folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        messages_repo::insert_headers(&db, folder.id, &[NewMessageHeader {
            uid: 1,
            message_id_hdr: None,
            in_reply_to: None,
            references_hdr: None,
            from_address: "a@b.com".into(),
            from_name: None,
            subject: "Hello".into(),
            date: 1000,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 100,
            snippet: "".into(),
        }]).unwrap();
        let msg = messages_repo::list_by_folder(&db, folder.id, 1, 0).unwrap().into_iter().next().unwrap();
        let body = MessageBody { message_id: msg.id, text_plain: Some("plain".into()), text_html: None };
        messages_repo::store_body(&db, msg.id, &body).unwrap();

        let fetched = messages_repo::get_body(&db, msg.id).unwrap().unwrap();
        assert_eq!(fetched.text_plain, Some("plain".into()));
    }
}
