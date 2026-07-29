use notify_rust::{Notification, NotificationResponse};
use tauri::AppHandle;
use tauri_specta::Event;

use crate::events::NotificationActivated;

pub const NEW_MAIL_NOTIFICATION_ID: u32 = 4711;
pub const SEND_ERROR_NOTIFICATION_ID: u32 = 4712;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationOutcome {
    Activated,
    Ignored,
}

pub fn outcome_for(response: &NotificationResponse) -> NotificationOutcome {
    match response {
        NotificationResponse::Default | NotificationResponse::Action(_) => NotificationOutcome::Activated,
        _ => NotificationOutcome::Ignored,
    }
}

pub fn show(app: &AppHandle, id: u32, title: String, body: String, target: NotificationActivated) {
    let app = app.clone();
    std::thread::spawn(move || {
        let handle = Notification::new()
            .summary(&title)
            .body(&body)
            .id(id)
            .action("default", "Open")
            .show();

        let handle = match handle {
            Ok(handle) => handle,
            Err(err) => {
                eprintln!("failed to show notification: {err}");
                return;
            }
        };

        let _ = handle.wait_for_response(move |response: &NotificationResponse| {
            if outcome_for(response) == NotificationOutcome::Activated {
                crate::window::focus_main_window(&app);
                let _ = target.emit(&app);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_rust::CloseReason;

    #[test]
    fn body_click_activates() {
        assert_eq!(outcome_for(&NotificationResponse::Default), NotificationOutcome::Activated);
    }

    #[test]
    fn named_action_activates() {
        assert_eq!(
            outcome_for(&NotificationResponse::Action("default".to_string())),
            NotificationOutcome::Activated
        );
    }

    #[test]
    fn windows_style_action_key_activates() {
        assert_eq!(
            outcome_for(&NotificationResponse::Action("__clicked".to_string())),
            NotificationOutcome::Activated
        );
    }

    #[test]
    fn dismissal_is_ignored() {
        assert_eq!(
            outcome_for(&NotificationResponse::Closed(CloseReason::Dismissed)),
            NotificationOutcome::Ignored
        );
    }

    #[test]
    fn expiry_is_ignored() {
        assert_eq!(
            outcome_for(&NotificationResponse::Closed(CloseReason::Expired)),
            NotificationOutcome::Ignored
        );
    }

    #[test]
    fn programmatic_close_is_ignored() {
        assert_eq!(
            outcome_for(&NotificationResponse::Closed(CloseReason::CloseAction)),
            NotificationOutcome::Ignored
        );
    }
}
