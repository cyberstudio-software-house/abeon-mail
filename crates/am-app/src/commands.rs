use std::sync::Arc;

use rand::Rng;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use am_core::{
    account::Account,
    folder::Folder,
    label::Label,
    message::{MessageBody, MessageFlag, MessageHeader},
    notification::NotificationContent,
    outgoing::{OutgoingAttachment, OutgoingMessage, SendError},
    rule::{Rule, RuleInput},
    signature::Signature,
    smart::{SmartFolderKind, SmartMessageRow},
    thread::ThreadSummary,
};
use am_storage::{accounts_repo, drafts_repo, folders_repo, labels_repo, messages_repo, notifications_repo, queue_repo, settings_repo, signatures_repo, smart_repo};
use tauri_plugin_dialog::DialogExt;

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

pub(crate) async fn remove_account_inner(
    db: &am_storage::Database,
    engine: Option<&am_sync::engine::SyncEngine>,
    account_id: i64,
) -> Result<(), String> {
    if let Some(eng) = engine {
        eng.stop_account(account_id);
    }

    let auth_ref = accounts_repo::get_account_auth_ref(db, account_id)
        .unwrap_or_default();

    if !auth_ref.is_empty() {
        match am_auth::credentials::delete_password(&auth_ref) {
            Ok(()) => {}
            Err(am_auth::AuthError::NotFound) => {}
            Err(e) => return Err(e.to_string()),
        }
    }

    accounts_repo::delete_account(db, account_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn remove_account(
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<(), String> {
    let engine_arc = state.engine.lock().unwrap().clone();
    remove_account_inner(&state.db, engine_arc.as_deref(), account_id).await
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
    messages_repo::list_by_folder(&state.db, folder_id, limit, offset, am_sync::service::now_secs()).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_message_body(
    state: tauri::State<'_, AppState>,
    message_id: i64,
) -> Result<MessageBody, String> {
    let db: Arc<am_storage::Database> = Arc::clone(&state.db);
    let creds = Arc::clone(&state.creds);
    am_sync::service::get_or_fetch_body(&db, message_id, creds.as_ref())
        .await
        .map_err(|_| "Failed to fetch message body".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn sanitize_message_html(html: String) -> am_mime::sanitize::SanitizedHtml {
    am_mime::sanitize::sanitize_html(&html)
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
pub struct RenderedMessage {
    pub html: Option<String>,
    pub blocked_remote_content: bool,
    pub remote_loaded: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn render_message_html(
    state: tauri::State<'_, AppState>,
    message_id: i64,
    force_load_remote: bool,
) -> Result<RenderedMessage, String> {
    use base64::Engine;

    let db: Arc<am_storage::Database> = Arc::clone(&state.db);
    let creds = Arc::clone(&state.creds);

    let body = am_sync::service::get_or_fetch_body(&db, message_id, creds.as_ref())
        .await
        .map_err(|_| "Failed to fetch message body".to_string())?;

    let html = match body.text_html {
        Some(h) => h,
        None => {
            return Ok(RenderedMessage {
                html: None,
                blocked_remote_content: false,
                remote_loaded: false,
            })
        }
    };

    let account_id = messages_repo::get_header(&db, message_id)
        .map(|h| h.account_id)
        .map_err(|e| e.to_string())?;
    let autoload = settings_repo::get_setting(&db, &format!("images.autoload.{account_id}"))
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false);
    let load_remote = force_load_remote || autoload;

    let inline = am_storage::attachments_repo::inline_parts(&db, message_id).map_err(|e| e.to_string())?;
    let mut cid_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (cid, mime, content) in inline {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&content);
        cid_map.insert(cid.to_ascii_lowercase(), format!("data:{mime};base64,{b64}"));
    }

    let empty = std::collections::HashMap::new();
    let first = am_mime::sanitize::sanitize_for_reader(&html, load_remote, &cid_map, &empty);
    if !load_remote {
        return Ok(RenderedMessage {
            html: Some(first.html),
            blocked_remote_content: first.blocked_remote_content,
            remote_loaded: false,
        });
    }

    let mut remote_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for url in first.remote_urls {
        if let Some(data_uri) = fetch_remote_image(&url).await {
            remote_map.insert(url, data_uri);
        }
    }

    let second = am_mime::sanitize::sanitize_for_reader(&html, false, &cid_map, &remote_map);
    Ok(RenderedMessage {
        html: Some(second.html),
        blocked_remote_content: second.blocked_remote_content,
        remote_loaded: true,
    })
}

fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 0x40)
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return true;
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80
        }
    }
}

async fn fetch_remote_image(url: &str) -> Option<String> {
    use base64::Engine;

    const MAX_BYTES: usize = 8 * 1024 * 1024;

    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_string();
    let port = parsed.port_or_known_default()?;

    let resolved: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .ok()?
        .collect();
    if resolved.is_empty() || resolved.iter().any(|addr| is_blocked_ip(addr.ip())) {
        return None;
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(&host, resolved[0])
        .build()
        .ok()?;

    let resp = client.get(parsed).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mime = match resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        Some(ct) => {
            let m = ct.split(';').next().unwrap_or("").trim().to_string();
            if !m.starts_with("image/") {
                return None;
            }
            m
        }
        None => "image/png".to_string(),
    };
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

#[tauri::command]
#[specta::specta]
pub async fn list_attachments(
    state: tauri::State<'_, AppState>,
    message_id: i64,
) -> Result<Vec<am_core::message::Attachment>, String> {
    let db: Arc<am_storage::Database> = Arc::clone(&state.db);
    let creds = Arc::clone(&state.creds);
    let _ = am_sync::service::get_or_fetch_body(&db, message_id, creds.as_ref()).await;
    am_storage::attachments_repo::list_meta(&db, message_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn save_attachment(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    attachment_id: i64,
) -> Result<bool, String> {
    let (filename, _mime, content) =
        am_storage::attachments_repo::get_content(&state.db, attachment_id).map_err(|e| e.to_string())?;

    let chosen = tokio::task::spawn_blocking(move || {
        app.dialog().file().set_file_name(filename).blocking_save_file()
    })
    .await
    .map_err(|_| "Save dialog task failed".to_string())?;

    let fp = match chosen {
        None => return Ok(false),
        Some(v) => v,
    };
    let path = fp
        .as_path()
        .ok_or_else(|| "Invalid save path".to_string())?
        .to_path_buf();
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub async fn open_attachment(
    state: tauri::State<'_, AppState>,
    attachment_id: i64,
) -> Result<(), String> {
    let (filename, _mime, content) =
        am_storage::attachments_repo::get_content(&state.db, attachment_id).map_err(|e| e.to_string())?;

    let mut dir = std::env::temp_dir();
    dir.push("abeonmail-attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = filename.replace(['/', '\\'], "_");
    dir.push(format!("{attachment_id}-{safe}"));
    std::fs::write(&dir, &content).map_err(|e| e.to_string())?;

    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())?;
    Ok(())
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
    am_storage::threads_repo::list_for_folder(&state.db, folder_id, limit, offset, am_sync::service::now_secs()).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_smart_folder(
    state: tauri::State<'_, AppState>,
    kind: SmartFolderKind,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, String> {
    smart_repo::list_smart_folder(&state.db, kind, limit, offset, am_sync::service::now_secs()).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn search_messages(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, String> {
    let parsed = am_core::search::parse_query(&query);
    am_storage::search_repo::search(&state.db, &parsed, limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_labels(state: tauri::State<'_, AppState>) -> Result<Vec<Label>, String> {
    labels_repo::list_labels(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn create_label(
    state: tauri::State<'_, AppState>,
    name: String,
    color: String,
) -> Result<Label, String> {
    labels_repo::create_label(&state.db, &name, &color).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn rename_label(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    labels_repo::rename_label(&state.db, id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_label_color(
    state: tauri::State<'_, AppState>,
    id: i64,
    color: String,
) -> Result<(), String> {
    labels_repo::set_label_color(&state.db, id, &color).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_label(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    labels_repo::delete_label(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_message_labels(
    state: tauri::State<'_, AppState>,
    label_id: i64,
    message_ids: Vec<i64>,
    applied: bool,
) -> Result<(), String> {
    labels_repo::set_message_labels(&state.db, label_id, &message_ids, applied)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn labels_for_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
) -> Result<Vec<(i64, Label)>, String> {
    labels_repo::labels_for_messages(&state.db, &message_ids).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_messages_by_label(
    state: tauri::State<'_, AppState>,
    label_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<SmartMessageRow>, String> {
    labels_repo::list_messages_by_label(&state.db, label_id, limit, offset, am_sync::service::now_secs())
        .map_err(|e| e.to_string())
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

#[tauri::command]
#[specta::specta]
pub fn list_send_errors(state: tauri::State<'_, AppState>) -> Result<Vec<SendError>, String> {
    let accounts = accounts_repo::list_accounts(&state.db).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for account in accounts {
        let mut errors = am_sync::send::list_send_errors(&state.db, account.id)
            .map_err(|_| "Failed to list send errors".to_string())?;
        out.append(&mut errors);
    }
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub fn retry_send(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    queue_repo::reset_for_retry(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_send_error(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    queue_repo::mark_done(&state.db, id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn start_reply(
    state: tauri::State<'_, AppState>,
    message_id: i64,
    mode: String,
) -> Result<OutgoingMessage, String> {
    let reply_mode = match mode.as_str() {
        "reply" => am_sync::compose::ReplyMode::Reply,
        "reply_all" => am_sync::compose::ReplyMode::ReplyAll,
        "forward" => am_sync::compose::ReplyMode::Forward,
        _ => return Err("Invalid reply mode".to_string()),
    };
    let db: Arc<am_storage::Database> = Arc::clone(&state.db);
    let creds = Arc::clone(&state.creds);
    let (_account_id, msg) = am_sync::compose::build_prefill(&db, message_id, reply_mode, creds.as_ref())
        .await
        .map_err(|_| "Failed to build reply".to_string())?;
    Ok(msg)
}

#[tauri::command]
#[specta::specta]
pub fn save_draft(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    draft_id: Option<i64>,
    message: OutgoingMessage,
) -> Result<i64, String> {
    let id = drafts_repo::save_draft(&state.db, account_id, draft_id, &message)
        .map_err(|_| "Failed to save draft".to_string())?;
    let _ = am_sync::send::enqueue_draft_sync(&state.db, id);
    Ok(id)
}

#[tauri::command]
#[specta::specta]
pub fn get_draft(
    state: tauri::State<'_, AppState>,
    draft_id: i64,
) -> Result<OutgoingMessage, String> {
    drafts_repo::get_draft(&state.db, draft_id)
        .map(|(_account_id, msg)| msg)
        .map_err(|_| "Failed to get draft".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_drafts(
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<Vec<i64>, String> {
    drafts_repo::list_draft_ids(&state.db, account_id)
        .map_err(|_| "Failed to list drafts".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn discard_draft(
    state: tauri::State<'_, AppState>,
    draft_id: i64,
) -> Result<(), String> {
    drafts_repo::delete_draft(&state.db, draft_id)
        .map_err(|_| "Failed to discard draft".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_signatures(
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<Vec<Signature>, String> {
    signatures_repo::list_signatures(&state.db, account_id)
        .map_err(|_| "Failed to list signatures".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn create_signature(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    name: String,
    html: String,
    make_default: bool,
) -> Result<Signature, String> {
    signatures_repo::create_signature(&state.db, account_id, &name, &html, make_default)
        .map_err(|_| "Failed to create signature".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_signature(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    html: String,
) -> Result<(), String> {
    signatures_repo::update_signature(&state.db, id, &name, &html)
        .map_err(|_| "Failed to update signature".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_default_signature(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    id: i64,
) -> Result<(), String> {
    signatures_repo::set_default_signature(&state.db, account_id, id)
        .map_err(|_| "Failed to set default signature".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_signature(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    signatures_repo::delete_signature(&state.db, id)
        .map_err(|_| "Failed to delete signature".to_string())
}

fn guess_mime_from_extension(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
#[specta::specta]
pub async fn pick_attachment(app: tauri::AppHandle) -> Result<Vec<OutgoingAttachment>, String> {
    let paths = tokio::task::spawn_blocking(move || {
        app.dialog().file().blocking_pick_files()
    })
    .await
    .map_err(|_| "Attachment picker task failed".to_string())?;

    let file_paths = match paths {
        None => return Ok(Vec::new()),
        Some(v) => v,
    };

    let mut attachments = Vec::new();
    for fp in file_paths {
        let path = match fp.as_path() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("attachment")
            .to_string();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let mime_type = guess_mime_from_extension(ext).to_string();
        let blob_ref = path.to_string_lossy().into_owned();
        attachments.push(OutgoingAttachment {
            filename,
            mime_type,
            blob_ref,
            content_id: None,
        });
    }
    Ok(attachments)
}

pub(crate) fn parse_redirect_line(line: &str) -> Option<(String, String)> {
    let path = line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    let mut code = None;
    let mut state = None;
    for part in query.split('&') {
        if let Some(v) = part.strip_prefix("code=") {
            code = Some(url_decode(v));
        } else if let Some(v) = part.strip_prefix("state=") {
            state = Some(url_decode(v));
        }
    }
    Some((code?, state?))
}

fn url_decode(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.bytes().peekable();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h = chars.next().unwrap_or(b'0');
            let l = chars.next().unwrap_or(b'0');
            let hex = [h, l];
            if let Ok(s) = std::str::from_utf8(&hex) {
                if let Ok(v) = u8::from_str_radix(s, 16) {
                    out.push(v as char);
                    continue;
                }
            }
            out.push('%');
            out.push(h as char);
            out.push(l as char);
        } else if b == b'+' {
            out.push(' ');
        } else {
            out.push(b as char);
        }
    }
    out
}

#[tauri::command]
#[specta::specta]
pub fn reorder_accounts(
    state: tauri::State<'_, AppState>,
    ordered_ids: Vec<i64>,
) -> Result<(), String> {
    accounts_repo::reorder_accounts(&state.db, &ordered_ids).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_account_endpoints(
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<am_auth::endpoints::Endpoints, String> {
    am_sync::service::load_endpoints_pub(&state.db, account_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_account(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    display_name: String,
    color: Option<String>,
    endpoints: Option<am_auth::endpoints::Endpoints>,
    password: Option<String>,
) -> Result<Account, String> {
    let db: Arc<am_storage::Database> = Arc::clone(&state.db);
    let input = am_sync::service::UpdateAccountInput {
        account_id,
        display_name,
        color,
        endpoints,
        password,
    };
    let account = am_sync::service::update_account(&db, input).await.map_err(|e| match e {
        am_sync::service::SyncError::Keychain => "Keychain unavailable".to_string(),
        am_sync::service::SyncError::InvalidSettings => "Invalid server settings".to_string(),
        other => other.to_string(),
    })?;
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.stop_account(account_id);
        engine.spawn_account(account_id);
    }
    Ok(account)
}

#[tauri::command]
#[specta::specta]
pub async fn begin_reauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<(), String> {
    let account = accounts_repo::get_account(&state.db, account_id)
        .map_err(|e| e.to_string())?;

    let (new_tokens, email) = run_google_oauth_flow(&app).await?;

    if email != account.email {
        return Err("Signed-in Google account does not match this account".to_string());
    }

    let refresh_token = new_tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "No refresh token in Google response".to_string())?;
    am_auth::credentials::store_password(&account.email, &refresh_token)
        .map_err(|_| "Keychain unavailable".to_string())?;

    state.creds.token_manager().seed(&account.email, &new_tokens);

    accounts_repo::set_requires_reauth(&state.db, account_id, false)
        .map_err(|e| e.to_string())?;

    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.stop_account(account_id);
        engine.spawn_account(account_id);
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn begin_google_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Account, String> {
    let (tokens, email) = run_google_oauth_flow(&app).await?;

    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "No refresh token in Google response".to_string())?;
    am_auth::credentials::store_password(&email, &refresh_token)
        .map_err(|_| "Keychain unavailable".to_string())?;

    let db = Arc::clone(&state.db);
    let endpoints_json = serde_json::json!({
        "imap_host": "imap.gmail.com",
        "imap_port": 993,
        "imap_tls": true,
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 465,
        "smtp_tls": true
    })
    .to_string();

    let new_account = am_core::account::NewAccount {
        email: email.clone(),
        display_name: email.clone(),
        provider_type: am_core::account::ProviderType::GoogleOauth,
        color: None,
    };
    let account =
        am_storage::accounts_repo::insert_account_with_settings(&db, &new_account, &email, &endpoints_json)
            .map_err(|e| e.to_string())?;

    state.creds.token_manager().seed(&email, &tokens);

    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.spawn_account(account.id);
    }

    Ok(account)
}

pub(crate) async fn run_google_oauth_flow(
    _app: &tauri::AppHandle,
) -> Result<(am_auth::oauth::client::OAuthTokens, String), String> {
    let client_id = am_auth::oauth::google::google_client_id()
        .map_err(|_| "Google client ID not configured".to_string())?;
    let client_secret = am_auth::oauth::google::google_client_secret()
        .map_err(|_| "Google client secret not configured".to_string())?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let pkce = am_auth::oauth::pkce::generate_pkce();
    let csrf_state: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    let auth_url = am_auth::oauth::pkce::authorize_url(
        &client_id,
        &redirect_uri,
        &pkce.challenge,
        &csrf_state,
    );

    tauri_plugin_opener::open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    accept_redirect(
        listener,
        &csrf_state,
        &client_id,
        &client_secret,
        &pkce.verifier,
        &redirect_uri,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    settings_repo::get_all_settings(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_setting(state: tauri::State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    settings_repo::set_setting(&state.db, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn snooze_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
    wake_at: i64,
) -> Result<(), String> {
    am_storage::snooze_repo::snooze_messages(&state.db, &message_ids, wake_at).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn unsnooze_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
) -> Result<(), String> {
    am_storage::snooze_repo::unsnooze_messages(&state.db, &message_ids).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn build_new_mail_notification(
    state: tauri::State<'_, AppState>,
    folder_id: i64,
    count: i64,
) -> Result<Option<NotificationContent>, String> {
    notifications_repo::build_new_mail_notification(&state.db, folder_id, count)
        .map_err(|_| "Failed to build notification".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn refresh_unread_badge(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    use tauri::Manager;
    let count = if enabled {
        notifications_repo::count_inbox_unread(&state.db)
            .map_err(|_| "Failed to count unread".to_string())?
    } else {
        0
    };
    if let Some(window) = app.get_webview_window("main") {
        let badge = if count > 0 { Some(count) } else { None };
        let _ = window.set_badge_count(badge);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn list_rules(state: tauri::State<'_, AppState>, account_id: i64) -> Result<Vec<Rule>, String> {
    am_storage::rules_repo::list_rules(&state.db, account_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn create_rule(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    input: RuleInput,
) -> Result<Rule, String> {
    am_storage::rules_repo::create_rule(&state.db, account_id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_rule(
    state: tauri::State<'_, AppState>,
    rule_id: i64,
    input: RuleInput,
) -> Result<(), String> {
    am_storage::rules_repo::update_rule(&state.db, rule_id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_rule_enabled(
    state: tauri::State<'_, AppState>,
    rule_id: i64,
    enabled: bool,
) -> Result<(), String> {
    am_storage::rules_repo::set_rule_enabled(&state.db, rule_id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_rule(state: tauri::State<'_, AppState>, rule_id: i64) -> Result<(), String> {
    am_storage::rules_repo::delete_rule(&state.db, rule_id).map_err(|e| e.to_string())
}

async fn accept_redirect(
    listener: TcpListener,
    expected_state: &str,
    client_id: &str,
    client_secret: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<(am_auth::oauth::client::OAuthTokens, String), String> {
    let accept_timeout = std::time::Duration::from_secs(300);
    let (stream, _) = tokio::time::timeout(accept_timeout, listener.accept())
        .await
        .map_err(|_| "OAuth timeout: browser did not redirect in time".to_string())?
        .map_err(|e| e.to_string())?;

    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);
    let mut request_line = String::new();
    buf_reader
        .read_line(&mut request_line)
        .await
        .map_err(|e| e.to_string())?;

    let close_html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
        <html><body><p>Authentication complete. You may close this tab.</p></body></html>";

    let (code, returned_state) = match parse_redirect_line(request_line.trim()) {
        Some(v) => v,
        None => {
            let _ = writer
                .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nBad request")
                .await;
            return Err("Invalid redirect request".to_string());
        }
    };

    if returned_state != expected_state {
        let _ = writer
            .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nState mismatch")
            .await;
        return Err("OAuth state mismatch".to_string());
    }

    let _ = writer.write_all(close_html).await;

    let http = am_auth::oauth::client::ReqwestHttp::new();
    let tokens = am_auth::oauth::client::exchange_code(
        &http,
        client_id,
        client_secret,
        &code,
        verifier,
        redirect_uri,
    )
    .await
    .map_err(|_| "Token exchange failed".to_string())?;

    let email = am_auth::oauth::client::fetch_email(&http, &tokens.access_token)
        .await
        .map_err(|_| "Failed to fetch account email".to_string())?;

    Ok((tokens, email))
}

#[cfg(test)]
mod tests {
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::{MessageBody, NewMessageHeader};
    use am_storage::{accounts_repo, folders_repo, messages_repo, Database};
    use am_auth::credentials::store_password;

    fn install_in_mem_keyring() {
        use keyring::credential::{
            Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
        };
        use std::any::Any;
        use std::collections::HashMap;
        use std::sync::{Mutex, Once};

        static STORE: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
        static INIT: Once = Once::new();

        INIT.call_once(|| {
            *STORE.lock().unwrap() = Some(HashMap::new());

            #[derive(Debug)]
            struct InMemCred { service: String, user: String }
            impl CredentialApi for InMemCred {
                fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
                    let pw = String::from_utf8(secret.to_vec())
                        .map_err(|_| keyring::Error::BadEncoding(secret.to_vec()))?;
                    STORE.lock().unwrap().as_mut().unwrap()
                        .insert((self.service.clone(), self.user.clone()), pw);
                    Ok(())
                }
                fn get_secret(&self) -> keyring::Result<Vec<u8>> {
                    STORE.lock().unwrap().as_ref().unwrap()
                        .get(&(self.service.clone(), self.user.clone()))
                        .map(|s| s.as_bytes().to_vec())
                        .ok_or(keyring::Error::NoEntry)
                }
                fn delete_credential(&self) -> keyring::Result<()> {
                    STORE.lock().unwrap().as_mut().unwrap()
                        .remove(&(self.service.clone(), self.user.clone()))
                        .map(|_| ())
                        .ok_or(keyring::Error::NoEntry)
                }
                fn as_any(&self) -> &dyn Any { self }
            }

            struct InMemCredBuilder;
            impl CredentialBuilderApi for InMemCredBuilder {
                fn build(&self, _target: Option<&str>, service: &str, user: &str) -> keyring::Result<Box<Credential>> {
                    Ok(Box::new(InMemCred { service: service.to_string(), user: user.to_string() }))
                }
                fn as_any(&self) -> &dyn Any { self }
                fn persistence(&self) -> CredentialPersistence { CredentialPersistence::ProcessOnly }
            }

            keyring::set_default_credential_builder(Box::new(InMemCredBuilder));
        });
    }

    #[tokio::test]
    async fn remove_account_deletes_row_and_keychain_secret() {
        install_in_mem_keyring();
        let db = Database::open_in_memory().unwrap();
        let created = accounts_repo::insert_account_with_settings(
            &db,
            &NewAccount {
                email: "rm@example.com".into(),
                display_name: "Rm".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
            "rm@example.com",
            "{}",
        ).unwrap();

        let auth_ref = accounts_repo::get_account_auth_ref(&db, created.id).unwrap();
        store_password(&auth_ref, "secret").unwrap();

        let folder = am_storage::folders_repo::upsert_folder(
            &db, created.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox,
        ).unwrap();
        am_storage::messages_repo::insert_headers(&db, folder.id, &[am_core::message::NewMessageHeader {
            uid: 1,
            message_id_hdr: None,
            in_reply_to: None,
            references_hdr: None,
            from_address: "a@b.com".into(),
            from_name: None,
            subject: "Hi".into(),
            date: 1000,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 100,
            snippet: "".into(),
        }]).unwrap();

        super::remove_account_inner(&db, None, created.id).await.unwrap();

        let err = accounts_repo::get_account(&db, created.id).unwrap_err();
        assert!(matches!(err, am_storage::StorageError::NotFound));

        let folders = am_storage::folders_repo::list_folders(&db, created.id).unwrap();
        assert!(folders.is_empty());

        let load_err = am_auth::credentials::load_password(&auth_ref).unwrap_err();
        assert!(matches!(load_err, am_auth::AuthError::NotFound));
    }

    #[tokio::test]
    async fn remove_missing_account_errors_cleanly() {
        let db = Database::open_in_memory().unwrap();
        let result = super::remove_account_inner(&db, None, 9999).await;
        assert!(result.is_err());
    }

    #[test]
    fn parse_redirect_line_extracts_code_and_state() {
        let line = "GET /?code=AUTH_CODE_XYZ&state=CSRF_STATE_123 HTTP/1.1";
        let (code, state) = super::parse_redirect_line(line).unwrap();
        assert_eq!(code, "AUTH_CODE_XYZ");
        assert_eq!(state, "CSRF_STATE_123");
    }

    #[test]
    fn ssrf_guard_blocks_internal_addresses() {
        use std::net::IpAddr;
        let blocked = [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ];
        for s in blocked {
            let ip: IpAddr = s.parse().unwrap();
            assert!(super::is_blocked_ip(ip), "expected blocked: {s}");
        }

        let allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
        for s in allowed {
            let ip: IpAddr = s.parse().unwrap();
            assert!(!super::is_blocked_ip(ip), "expected allowed: {s}");
        }
    }

    #[test]
    fn parse_redirect_line_missing_state_returns_none() {
        let line = "GET /?code=AUTH_CODE_XYZ HTTP/1.1";
        assert!(super::parse_redirect_line(line).is_none());
    }

    #[test]
    fn parse_redirect_line_bad_format_returns_none() {
        assert!(super::parse_redirect_line("not a request").is_none());
    }

    #[test]
    fn parse_redirect_line_decodes_percent_encoded_code() {
        let line = "GET /?code=AUTH%2BCODE&state=xyz HTTP/1.1";
        let (code, state) = super::parse_redirect_line(line).unwrap();
        assert_eq!(code, "AUTH+CODE");
        assert_eq!(state, "xyz");
    }

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

        let msgs = messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].subject, "Hello");
    }

    #[test]
    fn list_smart_folder_all_inboxes_returns_empty_for_empty_db() {
        use am_core::smart::SmartFolderKind;
        use am_storage::{accounts_repo, folders_repo, Database};
        use am_core::account::{NewAccount, ProviderType};
        use am_core::folder::FolderType;

        let db = std::sync::Arc::new(Database::open_in_memory().unwrap());
        let acc = accounts_repo::insert_account(
            &db,
            &NewAccount {
                email: "s@example.com".into(),
                display_name: "S".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap();
        folders_repo::upsert_folder(&db, acc.id, "INBOX", "Inbox", FolderType::Inbox).unwrap();

        let result = am_storage::smart_repo::list_smart_folder(&db, SmartFolderKind::AllInboxes, 100, 0, i64::MAX).unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn reorder_accounts_command_reorders_in_db() {
        let db = Database::open_in_memory().unwrap();
        let a = accounts_repo::insert_account(&db, &NewAccount {
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        let b = accounts_repo::insert_account(&db, &NewAccount {
            email: "b@example.com".into(),
            display_name: "B".into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap();
        accounts_repo::reorder_accounts(&db, &[b.id, a.id]).unwrap();
        let list = accounts_repo::list_accounts(&db).unwrap();
        assert_eq!(list[0].id, b.id);
        assert_eq!(list[1].id, a.id);
    }

    #[test]
    fn label_repo_roundtrip_via_storage() {
        use am_storage::labels_repo;
        let db = Database::open_in_memory().unwrap();
        let created = labels_repo::create_label(&db, "Work", "#4f46e5").unwrap();
        let all = labels_repo::list_labels(&db).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);
        assert_eq!(all[0].name, "Work");
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
        let msg = messages_repo::list_by_folder(&db, folder.id, 1, 0, i64::MAX).unwrap().into_iter().next().unwrap();
        let body = MessageBody { message_id: msg.id, text_plain: Some("plain".into()), text_html: None };
        messages_repo::store_body(&db, msg.id, &body).unwrap();

        let fetched = messages_repo::get_body(&db, msg.id).unwrap().unwrap();
        assert_eq!(fetched.text_plain, Some("plain".into()));
    }

    #[test]
    fn snooze_and_unsnooze_roundtrip_through_repo() {
        let db = am_storage::Database::open_in_memory().unwrap();
        let acc = am_storage::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "c@e.com".into(), display_name: "C".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = am_storage::folders_repo::upsert_folder(&db, acc.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        am_storage::messages_repo::insert_headers(&db, folder.id, &[am_core::message::NewMessageHeader {
            uid: 1, message_id_hdr: Some("<c1@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "a@b.c".into(), from_name: None, subject: "S".into(), date: 100,
            seen: true, flagged: false, has_attachments: false, size: 0, snippet: String::new(),
        }]).unwrap();
        let msgs = messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        let id = msgs[0].id;

        am_storage::snooze_repo::snooze_messages(&db, &[id], 9000).unwrap();
        let snoozed = am_storage::snooze_repo::list_snoozed(&db, 5000, 10, 0).unwrap();
        assert_eq!(snoozed.len(), 1);

        am_storage::snooze_repo::unsnooze_messages(&db, &[id]).unwrap();
        let after = am_storage::snooze_repo::list_snoozed(&db, 5000, 10, 0).unwrap();
        assert_eq!(after.len(), 0);
    }
}
