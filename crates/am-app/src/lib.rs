pub mod commands;
pub mod state;

use tauri_specta::{collect_commands, Builder};

pub fn build_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::app_health,
        commands::list_accounts,
        commands::add_account,
    ])
}
