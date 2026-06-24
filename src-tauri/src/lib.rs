use am_app::{build_specta_builder, state::AppState};
use am_storage::{settings_repo, Database};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

fn is_external_navigation(url: &tauri::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https" | "tel") {
        return false;
    }
    !matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost")
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::dotenv();

    let builder = build_specta_builder();

    let mut tauri_builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_single_instance::init(
            |app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            },
        ));
    }

    tauri_builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::default())
                .title("AbeonMail")
                .inner_size(800.0, 600.0)
                .on_navigation(|url| {
                    if is_external_navigation(url) {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                        return false;
                    }
                    true
                })
                .build()?;
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
            let tray_enabled =
                matches!(settings_repo::get_setting(&db, "notifications.tray"), Ok(Some(ref v)) if v == "true");
            app.manage(AppState::new(db));
            if tray_enabled {
                if let Err(err) = am_app::tray::build_tray(app.handle()) {
                    eprintln!("failed to build system tray: {err}");
                }
            }
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.clone().on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if handle.tray_by_id("main").is_some() {
                            api.prevent_close();
                            let _ = main.hide();
                        }
                    }
                });
            }
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
