use am_app::{build_specta_builder, state::AppState};
use am_storage::Database;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::dotenv();

    let builder = build_specta_builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("cannot create app data dir");
            let db_path = dir.join("abeonmail.db");
            let db = Database::open(db_path.to_str().expect("non-utf8 db path"))
                .expect("cannot open database");
            if let Err(err) =
                am_storage::maintenance::redecode_legacy_headers(&db, am_mime::rfc2047::decode)
            {
                eprintln!("header redecode migration failed: {err}");
            }
            app.manage(AppState::new(db));
            let state: tauri::State<AppState> = app.state();
            let sink = std::sync::Arc::new(am_app::sink::AppEventSink { app: app.handle().clone() });
            let rt = tauri::async_runtime::handle();
            let _rt_guard = rt.inner().enter();
            let engine = am_sync::engine::SyncEngine::start(
                std::sync::Arc::clone(&state.db),
                sink,
                std::sync::Arc::clone(&state.creds) as std::sync::Arc<dyn am_sync::auth::CredentialSource>,
            );
            *state.engine.lock().unwrap() = Some(engine);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
