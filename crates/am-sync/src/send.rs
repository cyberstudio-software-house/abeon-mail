use am_core::folder::FolderType;
use am_protocols::imap::ImapSession;
use am_protocols::smtp::{send_raw, SmtpConfig};
use am_storage::{accounts_repo, drafts_repo, folders_repo, queue_repo, Database};

use crate::auth::CredentialSource;
use crate::events::{SyncEvent, SyncEventSink};
use crate::service::{imap_config_pub, load_endpoints_pub, now_secs, SyncError};

fn handle_send_failure(
    db: &Database,
    sink: &dyn SyncEventSink,
    account_id: i64,
    op_id: i64,
    attempts: i64,
    error: &str,
    now: i64,
) -> Result<(), SyncError> {
    if attempts == 0 {
        sink.emit(SyncEvent::SendFailed {
            account_id,
            error: error.to_string(),
        });
    }
    if attempts + 1 >= MAX_SEND_ATTEMPTS {
        queue_repo::mark_failed(db, op_id, error)?;
    } else {
        let backoff = now + 2i64.pow((attempts + 1).min(5) as u32) * 30;
        queue_repo::mark_retry(db, op_id, backoff, Some(error))?;
    }
    Ok(())
}

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

pub fn list_send_errors(db: &Database, account_id: i64) -> Result<Vec<am_core::outgoing::SendError>, SyncError> {
    let rows = queue_repo::list_send_errors(db, account_id)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let parsed: serde_json::Value = serde_json::from_str(&row.payload).unwrap_or_default();
        let draft_id = parsed["draft_id"].as_i64().unwrap_or(0);
        let (subject, recipient) = match drafts_repo::get_draft(db, draft_id) {
            Ok((_, msg)) => (msg.subject, msg.to.first().cloned().unwrap_or_default()),
            Err(_) => (String::new(), String::new()),
        };
        out.push(am_core::outgoing::SendError {
            id: row.id,
            account_id: row.account_id,
            subject,
            recipient,
            error: row.last_error,
            attempts: row.attempts,
            permanent: row.state == "failed",
        });
    }
    Ok(out)
}

fn smtp_config(endpoints: &am_auth::endpoints::Endpoints, username: &str) -> SmtpConfig {
    SmtpConfig {
        host: endpoints.smtp_host.clone(),
        port: endpoints.smtp_port,
        tls: endpoints.smtp_tls,
        username: username.to_string(),
    }
}

pub async fn drain_outbox(db: &Database, account_id: i64, creds: &dyn CredentialSource, sink: &dyn SyncEventSink, now: i64) -> Result<(), SyncError> {
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
    let auth = creds.auth_for(&account).await?;

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
            send_raw(&smtp, &auth.to_smtp(), &msg.from_address, &recipients, &bytes).await;

        match send_result {
            Ok(()) => {
                let all_folders = folders_repo::list_folders(db, account_id)?;
                if let Some(sent) = all_folders.iter().find(|f| f.folder_type == FolderType::Sent) {
                    let config = imap_config_pub(&endpoints, &account.email);
                    if let Ok(mut session) = ImapSession::connect(&config, &auth.to_imap()).await {
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
            Err(e) => {
                let error = e.to_string();
                eprintln!("send_message failed (account {account_id}, draft {draft_id}): {error}");
                handle_send_failure(db, sink, account_id, op.id, op.attempts, &error, now_secs())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{RecordingSink, SyncEvent};
    use am_core::account::{NewAccount, ProviderType};

    fn seed_account(db: &Database) -> i64 {
        accounts_repo::insert_account(
            db,
            &NewAccount {
                email: "s@e.com".into(),
                display_name: "S".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn first_send_failure_emits_event_and_schedules_retry() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);
        let op_id = queue_repo::enqueue(&db, account_id, "send_message", "{\"draft_id\":1}").unwrap();
        let sink = RecordingSink::new();

        handle_send_failure(&db, &sink, account_id, op_id, 0, "connection failed: 465", 1000).unwrap();

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            SyncEvent::SendFailed { account_id: a, error } if *a == account_id && error == "connection failed: 465"
        ));
        let errors = queue_repo::list_send_errors(&db, account_id).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].state, "pending");
        assert_eq!(errors[0].last_error, "connection failed: 465");
    }

    #[test]
    fn subsequent_failure_does_not_reemit_but_records_error() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);
        let op_id = queue_repo::enqueue(&db, account_id, "send_message", "{\"draft_id\":1}").unwrap();
        let sink = RecordingSink::new();

        handle_send_failure(&db, &sink, account_id, op_id, 2, "still failing", 1000).unwrap();

        assert!(sink.events.lock().unwrap().is_empty());
        let errors = queue_repo::list_send_errors(&db, account_id).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].state, "pending");
    }

    #[test]
    fn final_failure_marks_failed() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);
        let op_id = queue_repo::enqueue(&db, account_id, "send_message", "{\"draft_id\":1}").unwrap();
        let sink = RecordingSink::new();

        handle_send_failure(&db, &sink, account_id, op_id, MAX_SEND_ATTEMPTS - 1, "gave up", 1000).unwrap();

        assert!(queue_repo::list_due(&db, account_id, 1_000_000).unwrap().is_empty());
        let errors = queue_repo::list_send_errors(&db, account_id).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].state, "failed");
    }

    #[test]
    fn list_send_errors_enriches_with_draft_subject_and_recipient() {
        use am_core::outgoing::OutgoingMessage;
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);
        let msg = OutgoingMessage {
            from_address: "me@e.com".into(),
            from_name: None,
            to: vec!["a@x.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hello".into(),
            text_body: "body".into(),
            html_body: None,
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
        };
        let draft_id = drafts_repo::save_draft(&db, account_id, None, &msg).unwrap();
        let op_id = queue_repo::enqueue(
            &db,
            account_id,
            "send_message",
            &format!("{{\"draft_id\":{draft_id}}}"),
        )
        .unwrap();
        queue_repo::mark_failed(&db, op_id, "connection failed: 465").unwrap();

        let errors = list_send_errors(&db, account_id).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].id, op_id);
        assert_eq!(errors[0].subject, "Hello");
        assert_eq!(errors[0].recipient, "a@x.com");
        assert_eq!(errors[0].error, "connection failed: 465");
        assert!(errors[0].permanent);
    }
}

pub async fn drain_draft_sync(db: &Database, account_id: i64, creds: &dyn CredentialSource, now: i64) -> Result<(), SyncError> {
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
    let auth = creds.auth_for(&account).await?;
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
            let mut session = ImapSession::connect(&config, &auth.to_imap()).await?;
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
                queue_repo::mark_retry(db, op.id, backoff, None)?;
            }
        }
    }
    Ok(())
}
