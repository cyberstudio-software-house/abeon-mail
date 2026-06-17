pub mod commands;
pub mod events;
pub mod sink;
pub mod state;

use tauri_specta::{collect_commands, collect_events, Builder};

pub fn build_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app_health,
            commands::list_accounts,
            commands::resolve_endpoints,
            commands::add_account,
            commands::list_folders,
            commands::list_messages,
            commands::get_message_body,
            commands::sanitize_message_html,
            commands::set_message_flags,
            commands::mark_message_seen,
        ])
        .events(collect_events![
            events::SyncProgress,
            events::NewMessages,
            events::MailboxChanged,
        ])
}
