use am_core::folder::FolderType;
use am_protocols::imap::ImapSession;
use am_protocols::smtp::{send_raw, SmtpConfig};
use am_storage::{accounts_repo, drafts_repo, folders_repo, queue_repo, Database};

use crate::service::{imap_config_pub, load_endpoints_pub, now_secs, SyncError};

const MAX_SEND_ATTEMPTS: i64 = 6;

pub fn enqueue_send(db: &Database, draft_id: i64) -> Result<(), SyncError> {
    let (account_id, _msg) = drafts_repo::get_draft(db, draft_id)?;
    let payload = serde_json::json!({ "draft_id": draft_id }).to_string();
    queue_repo::enqueue(db, account_id, "send_message", &payload)?;
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
            send_raw(&smtp, &password, &msg.from_address, &recipients, &bytes).await;

        match send_result {
            Ok(()) => {
                if let Some(sent) = folders_repo::list_folders(db, account_id)?
                    .into_iter()
                    .find(|f| f.folder_type == FolderType::Sent)
                {
                    let config = imap_config_pub(&endpoints, &account.email);
                    if let Ok(mut session) = ImapSession::connect(&config, &password).await {
                        let _ = session.append(&sent.remote_path, "\\Seen", &bytes).await;
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
