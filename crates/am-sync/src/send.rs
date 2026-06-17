use am_core::folder::FolderType;
use am_protocols::imap::{ImapAuth, ImapSession};
use am_protocols::smtp::{send_raw, SmtpAuth, SmtpConfig};
use am_storage::{accounts_repo, drafts_repo, folders_repo, queue_repo, Database};

use crate::service::{imap_config_pub, load_endpoints_pub, now_secs, SyncError};

const MAX_SEND_ATTEMPTS: i64 = 6;
const MAX_DRAFT_SYNC_ATTEMPTS: i64 = 6;

pub fn enqueue_send(db: &Database, draft_id: i64) -> Result<(), SyncError> {
    let (account_id, _msg) = drafts_repo::get_draft(db, draft_id)?;
    let payload = serde_json::json!({ "draft_id": draft_id }).to_string();
    queue_repo::enqueue(db, account_id, "send_message", &payload)?;
    Ok(())
}

pub fn enqueue_draft_sync(db: &Database, draft_id: i64) -> Result<(), SyncError> {
    let (account_id, _msg) = drafts_repo::get_draft(db, draft_id)?;
    let payload = serde_json::json!({ "draft_id": draft_id }).to_string();
    queue_repo::enqueue(db, account_id, "sync_draft", &payload)?;
    Ok(())
}

fn smtp_config(endpoints: &am_auth::endpoints::Endpoints, username: &str) -> SmtpConfig {
    SmtpConfig {
        host: endpoints.smtp_host.clone(),
        port: endpoints.smtp_port,
        tls: endpoints.smtp_tls,
        username: username.to_string(),
    }
}

pub async fn drain_outbox(db: &Database, account_id: i64, now: i64) -> Result<(), SyncError> {
    let due = queue_repo::list_due(db, account_id, now)?;
    let send_ops: Vec<_> = due
        .into_iter()
        .filter(|o| o.op_type == "send_message")
        .collect();
    if send_ops.is_empty() {
        return Ok(());
    }

    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints_pub(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;

    for op in send_ops {
        let parsed: serde_json::Value = match serde_json::from_str(&op.payload) {
            Ok(v) => v,
            Err(_) => {
                queue_repo::mark_done(db, op.id)?;
                continue;
            }
        };
        let draft_id = parsed["draft_id"].as_i64().unwrap_or(0);
        let (_acct, msg) = match drafts_repo::get_draft(db, draft_id) {
            Ok(v) => v,
            Err(_) => {
                queue_repo::mark_done(db, op.id)?;
                continue;
            }
        };

        let bytes = am_mime::compose::build_message(&msg);
        let mut recipients = msg.to.clone();
        recipients.extend(msg.cc.clone());
        recipients.extend(msg.bcc.clone());

        let smtp = smtp_config(&endpoints, &account.email);
        let send_result =
            send_raw(&smtp, &SmtpAuth::Password(password.clone()), &msg.from_address, &recipients, &bytes).await;

        match send_result {
            Ok(()) => {
                let all_folders = folders_repo::list_folders(db, account_id)?;
                if let Some(sent) = all_folders.iter().find(|f| f.folder_type == FolderType::Sent) {
                    let config = imap_config_pub(&endpoints, &account.email);
                    if let Ok(mut session) = ImapSession::connect(&config, &ImapAuth::Password(password.clone())).await {
                        let _ = session.append(&sent.remote_path, "(\\Seen)", &bytes).await;
                        if let Ok(Some(server_uid)) = drafts_repo::get_server_uid(db, draft_id) {
                            if let Some(drafts_folder) = all_folders.iter().find(|f| {
                                f.folder_type == FolderType::Drafts
                                    && folders_repo::get_sync_markers(db, f.id)
                                        .ok()
                                        .and_then(|m| m.uidvalidity)
                                        .is_some()
                            }) {
                                let _ = session
                                    .delete_uid(&drafts_folder.remote_path, server_uid)
                                    .await;
                            }
                        }
                        let _ = session.logout().await;
                    }
                }
                drafts_repo::delete_draft(db, draft_id)?;
                queue_repo::mark_done(db, op.id)?;
            }
            Err(_) if op.attempts + 1 >= MAX_SEND_ATTEMPTS => {
                queue_repo::mark_done(db, op.id)?;
            }
            Err(_) => {
                let backoff = now_secs() + 2i64.pow((op.attempts + 1).min(5) as u32) * 30;
                queue_repo::mark_retry(db, op.id, backoff)?;
            }
        }
    }
    Ok(())
}

pub async fn drain_draft_sync(db: &Database, account_id: i64, now: i64) -> Result<(), SyncError> {
    let due = queue_repo::list_due(db, account_id, now)?;
    let mut draft_ops: Vec<_> = due
        .into_iter()
        .filter(|o| o.op_type == "sync_draft")
        .collect();
    if draft_ops.is_empty() {
        return Ok(());
    }

    draft_ops.sort_by_key(|o| o.id);

    let mut seen_draft_ids: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for op in &draft_ops {
        let parsed: serde_json::Value = serde_json::from_str(&op.payload).unwrap_or_default();
        if let Some(draft_id) = parsed["draft_id"].as_i64() {
            seen_draft_ids.insert(draft_id, op.id);
        }
    }

    let all_folders = folders_repo::list_folders(db, account_id)?;
    let drafts_folder = all_folders.iter().find(|f| {
        f.folder_type == FolderType::Drafts
            && folders_repo::get_sync_markers(db, f.id)
                .ok()
                .and_then(|m| m.uidvalidity)
                .is_some()
    });

    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints_pub(db, account_id)?;
    let password = am_auth::credentials::load_password(&account.email)?;
    let config = imap_config_pub(&endpoints, &account.email);

    for op in &draft_ops {
        let parsed: serde_json::Value = match serde_json::from_str(&op.payload) {
            Ok(v) => v,
            Err(_) => {
                queue_repo::mark_done(db, op.id)?;
                continue;
            }
        };
        let draft_id = match parsed["draft_id"].as_i64() {
            Some(id) => id,
            None => {
                queue_repo::mark_done(db, op.id)?;
                continue;
            }
        };

        let newest_op_id = seen_draft_ids.get(&draft_id).copied().unwrap_or(op.id);
        if op.id != newest_op_id {
            queue_repo::mark_done(db, op.id)?;
            continue;
        }

        let (_acct, msg) = match drafts_repo::get_draft(db, draft_id) {
            Ok(v) => v,
            Err(_) => {
                queue_repo::mark_done(db, op.id)?;
                continue;
            }
        };

        let drafts_folder = match drafts_folder {
            Some(f) => f,
            None => {
                queue_repo::mark_done(db, op.id)?;
                continue;
            }
        };

        let bytes = am_mime::compose::build_message(&msg);

        let sync_result: Result<(), SyncError> = async {
            let mut session = ImapSession::connect(&config, &ImapAuth::Password(password.clone())).await?;
            let state = session.select(&drafts_folder.remote_path).await?;
            let prev_uid = drafts_repo::get_server_uid(db, draft_id).ok().flatten();
            let new_uid = state.uidnext;
            session
                .append(&drafts_folder.remote_path, "(\\Draft)", &bytes)
                .await?;
            drafts_repo::set_server_uid(db, draft_id, Some(new_uid))?;
            if let Some(old_uid) = prev_uid {
                let _ = session
                    .delete_uid(&drafts_folder.remote_path, old_uid)
                    .await;
            }
            let _ = session.logout().await;
            Ok(())
        }
        .await;

        match sync_result {
            Ok(()) => {
                queue_repo::mark_done(db, op.id)?;
            }
            Err(_) if op.attempts + 1 >= MAX_DRAFT_SYNC_ATTEMPTS => {
                queue_repo::mark_done(db, op.id)?;
            }
            Err(_) => {
                let backoff = now_secs() + 2i64.pow((op.attempts + 1).min(5) as u32) * 30;
                queue_repo::mark_retry(db, op.id, backoff)?;
            }
        }
    }
    Ok(())
}
