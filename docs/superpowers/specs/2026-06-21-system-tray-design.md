# System tray z licznikiem nieprzeczytanych — spec

Data: 2026-06-21

## Cel

Po włączeniu ustawienia „Minimize to tray on close" kliknięcie przycisku zamknięcia okna [X]
chowa okno zamiast kończyć aplikację, a w obszarze powiadomień (system tray) widoczna jest ikona
z **wyrenderowaną liczbą** nieprzeczytanych wiadomości w skrzynkach odbiorczych (wszystkie konta).
Gdy ustawienie jest wyłączone — brak ikony traya, a [X] kończy aplikację normalnie.

Źródło licznika jest wspólne z istniejącym badge: `notifications_repo::count_inbox_unread`.

## Zakres negatywny (YAGNI)

- Brak startu zminimalizowanego do traya.
- Brak ukrywania z docka na macOS (okno znika, aplikacja zostaje w docku + tray).
- Brak licznika per-konto.
- Brak tooltipa (świadomie pominięty — sygnał daje ikona + menu).

## Model zachowania

- Ustawienie `notifications.tray` (bool, domyślnie `false`).
- Włączone: ikona traya obecna przez cały czas działania; [X] chowa okno do traya.
- Wyłączone: brak ikony traya; [X] kończy aplikację.
- Reguła odporności: gdy ikona traya nie istnieje (np. nieudane utworzenie na Linux),
  [X] zawsze realnie kończy aplikację — użytkownik nigdy nie utknie bez sposobu przywrócenia okna.

## Backend (Rust)

### Moduł `crates/am-app/src/tray.rs`

- `build_tray(app) -> tauri::Result<TrayIcon>` — tworzy ikonę o id `"main"`:
  - menu kontekstowe: `Pokaż AbeonMail`, separator, nieklikalna etykieta `Nieprzeczytane: N`,
    separator, `Zakończ`;
  - lewy klik (`TrayIconEvent::Click`) → pokaż i sfokusuj okno `main`;
  - `on_menu_event` → `show`/`quit`;
  - baza obrazka: `app.default_window_icon()` (zbundlowana ikona, bez `include_bytes!`).
- Render licznika `render_badge_icon(base, count) -> tauri::image::Image`:
  - `count == 0` → bazowa ikona bez zmian;
  - `count > 0` → kompozycja czerwonej plakietki z liczbą (raster `tiny-skia`,
    cyfry przez `ab_glyph` z małym wbudowanym fontem);
  - `count > 99` → tekst `99+`.
- `update_tray(app, count)` — jeśli ikona istnieje: ustaw obraz przez `set_icon` i odśwież
  etykietę licznika w menu.

### Komendy (`crates/am-app/src/commands.rs`, rejestracja w `lib.rs`)

- `set_tray_enabled(app, state, enabled)` — tworzy ikonę (gdy `true` i nie istnieje, z natychmiastowym
  renderem aktualnego licznika) lub usuwa (`app.remove_tray_by_id("main")`).
- **Rozszerzenie `refresh_unread_badge`** — po ustawieniu badge, jeśli `app.tray_by_id("main")`
  istnieje, przerenderuj ikonę traya tym samym, już policzonym `count`. Bez zmian w 8 istniejących
  miejscach wywołań we frontendzie (tray „jedzie na gapę" z badge).

### `src-tauri/src/lib.rs`

- W `setup()`: po `app.manage(...)` odczytaj `notifications.tray` z DB
  (`settings_repo::get_setting`); jeśli `"true"` → `tray::build_tray(app)`.
- `window.on_window_event` dla okna `main`: na `CloseRequested`, jeśli `app.tray_by_id("main").is_some()`
  → `api.prevent_close()` + `window.hide()`; w przeciwnym razie pozwól zamknąć.

## Ustawienia i frontend

- `src/shared/notifications/notifications.ts`: dodać pole `trayEnabled`, klucz
  `NOTIFICATION_KEYS.tray = "notifications.tray"`, default `false`, obsługa w `parseNotificationSettings`.
- `src/app/store.ts`: stan `trayEnabled`, setter `setTrayEnabled`, rozszerzenie `hydrateNotifications`.
- `src/shared/notifications/NotificationsProvider.tsx`: ekspozycja `trayEnabled` + handler, który
  persistuje `notifications.tray` i wywołuje `commands.setTrayEnabled(v)`; efekt po hydratacji
  synchronizuje stan utworzony w `setup()`.
- `src/features/settings/NotificationsSection.tsx`: przełącznik „Minimize to tray on close",
  hint „Keep AbeonMail running in the system tray when you close the window; the tray icon shows your unread count.".
- Bindingi (`src/ipc/bindings.ts`) regenerowane przez `npm run gen:bindings`.

## Zależności i platformy

- `tauri` feature `tray-icon` (i ewentualnie `image-png`) — włączone w `src-tauri/Cargo.toml`
  oraz w `crates/am-app/Cargo.toml` (`tauri = { workspace = true, features = ["tray-icon"] }`),
  by `am-app` kompilował się samodzielnie.
- `crates/am-app/Cargo.toml`: `tiny-skia` + `ab_glyph` do renderu liczby (czyste Rust, bez zależności systemowych).
- Linux: `libayatana-appindicator3-1` w `bundle.linux.deb.depends` (`tauri.conf.json`); dev/build wymaga `libayatana-appindicator3-dev`.

## Testy

- Rust: `render_badge_icon` — `0` zwraca obraz równy bazie; `5` i `150` dają obraz różny od bazy; próg `99+`.
- Rust: logika progu/etykiety menu.
- TS: `parseNotificationSettings` parsuje `notifications.tray`; `NotificationsProvider` wywołuje
  `setTrayEnabled` i persistuje klucz (wzór jak testy badge).
- E2E traya (klik/hide) — weryfikacja manualna.

## Decyzja architektoniczna

Odświeżanie licznika: rozszerzenie `refresh_unread_badge` o aktualizację traya (sterowanie istnieniem ikony,
bez nowej flagi) — zero zmian w 8 miejscach wywołań, licznik liczony raz. Odrzucone: osobna komenda
`refresh_tray` (duplikacja), odświeżanie z sinka SyncEngine (rozjazd z badge przy lokalnym oznaczaniu przeczytania).
