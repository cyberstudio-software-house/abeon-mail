use am_app::{build_specta_builder, state::AppState};
use am_storage::Database;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = build_specta_builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("cannot create app data dir");
            let db_path = dir.join("abeonmail.db");
            let db = Database::open(db_path.to_str().expect("non-utf8 db path"))
                .expect("cannot open database");
            app.manage(AppState::new(db));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
