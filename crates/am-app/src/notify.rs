use notify_rust::NotificationResponse;

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
