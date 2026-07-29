# Notification Click Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kliknięcie w powiadomienie systemowe podnosi okno AbeonMail i otwiera wiadomość, której powiadomienie dotyczyło.

**Architecture:** Wysyłka powiadomień przenosi się z frontendu (`sendNotification` z `tauri-plugin-notification`) do własnej warstwy w Rust opartej na `notify-rust`, bo tylko tam da się zatrzymać `NotificationHandle` i nasłuchać kliknięcia. Powiadomienie deklaruje akcję `default`; dedykowany wątek czeka w `wait_for_response()`, a po aktywacji podnosi okno i emituje event `NotificationActivated`, który frontend zamienia na nawigację w store. Gating (przełącznik powiadomień, sprawdzenie focusu) zostaje we froncie.

**Tech Stack:** Rust (tauri 2, tauri-specta, notify-rust 4.18), TypeScript (React 19, zustand, vitest), SQLite przez rusqlite.

## Global Constraints

- **Node:** `.nvmrc` wymaga Node 24; aktywny w powłoce jest 18.19.1. Przed `npm run gen:bindings` i przed vitest wykonaj `nvm use 24` — na Node 18 Vite wywraca się na `crypto.hash`.
- **Bez komentarzy w kodzie.** Istotne ustalenia trafiają do `docs/`, nie do plików źródłowych.
- **Kod wyłącznie po angielsku** — nazwy zmiennych, stałych, funkcji, treści commitów.
- **Commity:** Conventional Commits 1.0.0, spójne z historią repo (`feat(zakres): …`, `fix(zakres): …`). Bez dopisywania współautora.
- **Wersja notify-rust:** `4.18` — dokładnie ta, która jest już w `Cargo.lock` jako zależność przechodnia pluginu. Nie podbijaj, żeby nie zdublować crate'a w drzewie.
- **Bez migracji bazy.** Ten plan nie dodaje ani nie zmienia żadnej tabeli.
- **Znane wcześniejsze faile vitest:** 12 (ConversationView ×3, useDebouncedValue ×3, store ×6). Nie są w zakresie i nie wolno ich „naprawiać" po drodze.
- **Spec:** `docs/superpowers/specs/2026-07-29-notification-click-focus-design.md`

---

## Struktura plików

| Plik | Odpowiedzialność | Status |
|---|---|---|
| `crates/am-core/src/notification.rs` | Typ treści powiadomienia przekraczający IPC | modyfikacja |
| `crates/am-storage/src/notifications_repo.rs` | Budowa treści + identyfikatorów celu z bazy | modyfikacja |
| `crates/am-app/src/window.rs` | Podnoszenie głównego okna — wspólne dla traya i powiadomień | **nowy** |
| `crates/am-app/src/tray.rs` | Tray; przestaje mieć własną kopię logiki focusu | modyfikacja |
| `crates/am-app/src/notify.rs` | Wysyłka powiadomienia + nasłuch kliknięcia + mapowanie odpowiedzi | **nowy** |
| `crates/am-app/src/events.rs` | Event `NotificationActivated` | modyfikacja |
| `crates/am-app/src/commands.rs` | Dwie cienkie komendy wysyłkowe | modyfikacja |
| `crates/am-app/src/lib.rs` | Rejestracja modułów, komend i eventu | modyfikacja |
| `src/ipc/events.ts` | Gating, wywołanie komend, nasłuch aktywacji, nawigacja | modyfikacja |
| `src/ipc/events.test.tsx` | Testy powyższego | modyfikacja |

---

### Task 1: Identyfikatory celu w treści powiadomienia

Bez tego kliknięcie nie ma dokąd prowadzić. `build_new_mail_notification` już czyta najnowszy wiersz — dokładamy do niego `id` i `thread_id`.

**Files:**
- Modify: `crates/am-core/src/notification.rs`
- Modify: `crates/am-storage/src/notifications_repo.rs`
- Test: `crates/am-storage/src/notifications_repo.rs` (istniejący `mod tests`)

**Interfaces:**
- Produces: `NotificationContent { title: String, body: String, thread_id: Option<i64>, message_id: Option<i64> }`
- Produces: `notifications_repo::build_new_mail_notification(db: &Database, folder_id: i64, count: i64) -> Result<Option<NotificationContent>, StorageError>` (sygnatura bez zmian)

**Uwaga o teście:** `insert_headers` **nie** ustawia `thread_id` — robi to `assign_threads`, które mieszka w `am-sync`, a `am-storage` nie może od niego zależeć. Dlatego test ustawia `thread_id` bezpośrednim `UPDATE`. Nie da się wpisać dowolnej liczby: `messages.thread_id` ma klucz obcy do `threads(id)`, więc test musi najpierw wstawić wiersz do `threads` (wymagane kolumny: `account_id`, `subject_root`, `last_date`) i użyć jego `last_insert_rowid()`. Odczyty i zapisy trzymaj w jednym bloku `{ let conn = db.conn(); … }`, żeby guard połączenia zwolnił się przed wywołaniem `build_new_mail_notification`.

- [ ] **Step 1: Dopisz failujące testy**

W `crates/am-storage/src/notifications_repo.rs`, wewnątrz istniejącego `mod tests`:

```rust
    #[test]
    fn single_carries_thread_and_message_ids() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, Some("Alice"), "alice@example.com", "Lunch?", 1000)]).unwrap();
        let (message_id, thread_id) = {
            let conn = db.conn();
            let message_id: i64 = conn
                .query_row("SELECT id FROM messages WHERE folder_id = ?1", params![inbox], |r| r.get(0))
                .unwrap();
            conn.execute(
                "INSERT INTO threads (account_id, subject_root, last_date) VALUES (?1, ?2, ?3)",
                params![acc, "Lunch?", 1000],
            )
            .unwrap();
            let thread_id = conn.last_insert_rowid();
            conn.execute(
                "UPDATE messages SET thread_id = ?1 WHERE id = ?2",
                params![thread_id, message_id],
            )
            .unwrap();
            (message_id, thread_id)
        };

        let n = build_new_mail_notification(&db, inbox, 1).unwrap().unwrap();
        assert_eq!(n.message_id, Some(message_id));
        assert_eq!(n.thread_id, Some(thread_id));
    }

    #[test]
    fn aggregate_carries_no_ids() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            header(1, Some("Alice"), "alice@example.com", "Lunch?", 1000),
            header(2, Some("Bob"), "bob@example.com", "Report", 2000),
        ]).unwrap();

        let n = build_new_mail_notification(&db, inbox, 2).unwrap().unwrap();
        assert_eq!(n.message_id, None);
        assert_eq!(n.thread_id, None);
    }
```

- [ ] **Step 2: Uruchom testy i potwierdź, że failują**

Run: `cargo test -p am-storage notifications_repo`
Expected: FAIL — `no field 'message_id' on type 'NotificationContent'`

- [ ] **Step 3: Rozszerz typ**

W `crates/am-core/src/notification.rs` zamień całą definicję struktury na:

```rust
#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct NotificationContent {
    pub title: String,
    pub body: String,
    pub thread_id: Option<i64>,
    pub message_id: Option<i64>,
}
```

- [ ] **Step 4: Poszerz zapytanie i konstrukcje**

W `crates/am-storage/src/notifications_repo.rs`, w gałęzi `count == 1`, zamień odczyt wiersza:

```rust
        let row: Option<(Option<String>, String, String, i64, Option<i64>)> = conn
            .query_row(
                "SELECT from_name, from_address, subject, id, thread_id FROM messages
                 WHERE folder_id = ?1 AND draft = 0 AND deleted = 0
                 ORDER BY date DESC LIMIT 1",
                params![folder_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((from_name, from_address, subject, message_id, thread_id)) = row else {
            return Ok(None);
        };
```

oraz zwracaną wartość tej gałęzi:

```rust
        Ok(Some(NotificationContent { title, body, thread_id, message_id: Some(message_id) }))
```

W gałęzi agregatu (`else`) zamień zwracaną wartość na:

```rust
        Ok(Some(NotificationContent {
            title,
            body: format!("{count} new messages"),
            thread_id: None,
            message_id: None,
        }))
```

- [ ] **Step 5: Uruchom testy i potwierdź, że przechodzą**

Run: `cargo test -p am-storage notifications_repo`
Expected: PASS — nowe testy zielone, istniejące (`non_inbox_folder_returns_none`, `single_uses_sender_name_and_subject`, `single_falls_back_to_address_when_name_empty`) nadal zielone.

- [ ] **Step 6: Sprawdź, czy nic innego nie konstruuje tego typu**

Run: `rg -n "NotificationContent \{" crates/ -g '*.rs'`
Expected: wyłącznie dwa miejsca w `notifications_repo.rs`. Jeśli pojawi się inne — dopisz tam `thread_id: None, message_id: None`.

- [ ] **Step 7: Commit**

```bash
git add crates/am-core/src/notification.rs crates/am-storage/src/notifications_repo.rs
git commit -m "feat(notifications): carry click target ids in notification content"
```

---

### Task 2: Wspólny helper podnoszenia okna

`tray.rs` ma prywatne `focus_main_window`, którego będzie potrzebować także warstwa powiadomień. Wyciągamy je zamiast kopiować.

**Files:**
- Create: `crates/am-app/src/window.rs`
- Modify: `crates/am-app/src/tray.rs` (usunięcie prywatnej funkcji, podmiana wywołań)
- Modify: `crates/am-app/src/lib.rs` (deklaracja modułu)

**Interfaces:**
- Produces: `crate::window::focus_main_window(app: &tauri::AppHandle)`

To czysty refaktor — zachowanie nie zmienia się ani o jotę, więc nie dochodzi nowy test. Weryfikacją jest kompilacja i istniejące testy `am-app`.

- [ ] **Step 1: Utwórz moduł**

Utwórz `crates/am-app/src/window.rs` z treścią:

```rust
use tauri::Manager;

pub fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
```

- [ ] **Step 2: Zadeklaruj moduł**

W `crates/am-app/src/lib.rs` dopisz do listy modułów na górze pliku (obok `pub mod tray;`):

```rust
pub mod window;
```

- [ ] **Step 3: Usuń duplikat z tray.rs**

W `crates/am-app/src/tray.rs` usuń całą prywatną funkcję:

```rust
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
```

i podmień oba wywołania — w `on_tray_icon_event` oraz w gałęzi `"tray_show"` — na `crate::window::focus_main_window(...)`:

```rust
                focus_main_window(tray.app_handle());
```
→
```rust
                crate::window::focus_main_window(tray.app_handle());
```

```rust
            "tray_show" => focus_main_window(app),
```
→
```rust
            "tray_show" => crate::window::focus_main_window(app),
```

- [ ] **Step 4: Zbuduj i uruchom testy**

Run: `cargo test -p am-app`
Expected: PASS — kompiluje się, testy `tray` (`zero_count_returns_base_unchanged`, `label_threshold` i pozostałe) zielone.

Jeśli kompilator zgłosi nieużywany import `tauri::Manager` w `tray.rs`, zostaw go — `Manager` jest tam nadal potrzebny dla `app.state()` w `build_tray` i `app.tray_by_id` w `update_tray`. Usuń tylko wtedy, gdy kompilator faktycznie go wskaże jako nieużywany.

- [ ] **Step 5: Commit**

```bash
git add crates/am-app/src/window.rs crates/am-app/src/tray.rs crates/am-app/src/lib.rs
git commit -m "refactor(app): extract shared focus_main_window helper"
```

---

### Task 3: Warstwa wysyłki powiadomień z nasłuchem kliknięcia

Serce naprawy. Mapowanie odpowiedzi jest czystą funkcją — testujemy je bez D-Bus.

**Files:**
- Create: `crates/am-app/src/notify.rs`
- Modify: `crates/am-app/Cargo.toml`
- Modify: `crates/am-app/src/lib.rs`

**Interfaces:**
- Consumes: `crate::window::focus_main_window` (Task 2), `crate::events::NotificationActivated` (Task 4 — moduł musi powstać przed kompilacją, dlatego Task 4 dokłada typ; jeśli wykonujesz taski po kolei, ten kod nie skompiluje się aż do Task 4 — patrz Step 5)
- Produces: `notify::NotificationOutcome { Activated, Ignored }`
- Produces: `notify::outcome_for(response: &NotificationResponse) -> NotificationOutcome`
- Produces: `notify::show(app: &AppHandle, id: u32, title: String, body: String, target: NotificationActivated)`
- Produces: `notify::NEW_MAIL_NOTIFICATION_ID: u32`, `notify::SEND_ERROR_NOTIFICATION_ID: u32`

- [ ] **Step 1: Dodaj zależność**

W `crates/am-app/Cargo.toml`, w sekcji `[dependencies]`, dopisz w porządku alfabetycznym (między `font8x8` a `rand`):

```toml
notify-rust = "4.18"
```

- [ ] **Step 2: Napisz failujący test mapowania**

Utwórz `crates/am-app/src/notify.rs` — na razie **wyłącznie** z testami i typem wyniku, żeby zobaczyć czerwone:

```rust
use notify_rust::NotificationResponse;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationOutcome {
    Activated,
    Ignored,
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
```

W `crates/am-app/src/lib.rs` dopisz do listy modułów:

```rust
pub mod notify;
```

- [ ] **Step 3: Uruchom testy i potwierdź, że failują**

Run: `cargo test -p am-app notify`
Expected: FAIL — `cannot find function 'outcome_for' in this scope`

- [ ] **Step 4: Zaimplementuj mapowanie**

W `crates/am-app/src/notify.rs`, nad blokiem `#[cfg(test)]`:

```rust
pub fn outcome_for(response: &NotificationResponse) -> NotificationOutcome {
    match response {
        NotificationResponse::Default | NotificationResponse::Action(_) => NotificationOutcome::Activated,
        _ => NotificationOutcome::Ignored,
    }
}
```

- [ ] **Step 5: Uruchom testy i potwierdź, że przechodzą**

Run: `cargo test -p am-app notify`
Expected: PASS — sześć testów zielonych.

Jeśli `CloseReason` lub `NotificationResponse` nie dają się zaimportować, sprawdź faktyczną ścieżkę: `rg -n "pub enum NotificationResponse" ~/.cargo/registry/src/*/notify-rust-4.18.0/src/response.rs`

- [ ] **Step 6: Commit mapowania**

```bash
git add crates/am-app/Cargo.toml crates/am-app/src/notify.rs crates/am-app/src/lib.rs Cargo.lock
git commit -m "feat(notifications): map notification responses to activation outcome"
```

- [ ] **Step 7: Dopisz wysyłkę**

Ten kod odwołuje się do `NotificationActivated`, który powstaje w Task 4 — dlatego skompiluje się dopiero po tamtym zadaniu. Dopisz go teraz, a kompilację zweryfikuj w Task 4 Step 5.

W `crates/am-app/src/notify.rs`, na górze pliku rozszerz import i dopisz stałe oraz funkcję wysyłki:

```rust
use notify_rust::{Notification, NotificationResponse};
use tauri::AppHandle;
use tauri_specta::Event;

use crate::events::NotificationActivated;

pub const NEW_MAIL_NOTIFICATION_ID: u32 = 4711;
pub const SEND_ERROR_NOTIFICATION_ID: u32 = 4712;
```

oraz, poniżej `outcome_for`:

```rust
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
```

Akcja `default` jest obowiązkowa: bez zadeklarowanej akcji serwer XDG nie wyśle `ActionInvoked` i kliknięcie znów przepadnie.

---

### Task 4: Event aktywacji i komendy wysyłkowe

**Files:**
- Modify: `crates/am-app/src/events.rs`
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs`
- Test: `crates/am-app/src/events.rs` (nowy `mod tests`)

**Interfaces:**
- Consumes: `notify::show`, `notify::NEW_MAIL_NOTIFICATION_ID`, `notify::SEND_ERROR_NOTIFICATION_ID` (Task 3)
- Produces: `events::NotificationActivated { account_id: Option<i64>, folder_id: Option<i64>, thread_id: Option<i64>, message_id: Option<i64> }`
- Produces: komendy `show_new_mail_notification(account_id, folder_id, count)`, `show_send_error_notification(error)`

- [ ] **Step 1: Napisz failujący test struktury eventu**

Na końcu `crates/am-app/src/events.rs` dopisz:

```rust
#[cfg(test)]
mod tests {
    use super::NotificationActivated;

    #[test]
    fn activation_carries_full_target() {
        let ev = NotificationActivated {
            account_id: Some(1),
            folder_id: Some(2),
            thread_id: Some(3),
            message_id: Some(4),
        };
        assert_eq!(ev.account_id, Some(1));
        assert_eq!(ev.folder_id, Some(2));
        assert_eq!(ev.thread_id, Some(3));
        assert_eq!(ev.message_id, Some(4));
    }

    #[test]
    fn activation_allows_focus_only_target() {
        let ev = NotificationActivated {
            account_id: None,
            folder_id: None,
            thread_id: None,
            message_id: None,
        };
        assert!(ev.account_id.is_none());
        assert!(ev.folder_id.is_none());
    }
}
```

- [ ] **Step 2: Uruchom test i potwierdź, że failuje**

Run: `cargo test -p am-app events`
Expected: FAIL — `cannot find type 'NotificationActivated'`

- [ ] **Step 3: Dodaj typ eventu**

W `crates/am-app/src/events.rs`, nad blokiem `#[cfg(test)]`:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct NotificationActivated {
    pub account_id: Option<i64>,
    pub folder_id: Option<i64>,
    pub thread_id: Option<i64>,
    pub message_id: Option<i64>,
}
```

- [ ] **Step 4: Dodaj komendy**

W `crates/am-app/src/commands.rs`, bezpośrednio pod istniejącą `build_new_mail_notification`:

```rust
#[tauri::command]
#[specta::specta]
pub fn show_new_mail_notification(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: i64,
    folder_id: i64,
    count: i64,
) -> Result<(), String> {
    let Some(content) = notifications_repo::build_new_mail_notification(&state.db, folder_id, count)
        .map_err(|_| "Failed to build notification".to_string())?
    else {
        return Ok(());
    };
    let target = crate::events::NotificationActivated {
        account_id: Some(account_id),
        folder_id: Some(folder_id),
        thread_id: content.thread_id,
        message_id: content.message_id,
    };
    crate::notify::show(
        &app,
        crate::notify::NEW_MAIL_NOTIFICATION_ID,
        content.title,
        content.body,
        target,
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn show_send_error_notification(app: tauri::AppHandle, error: String) -> Result<(), String> {
    let target = crate::events::NotificationActivated {
        account_id: None,
        folder_id: None,
        thread_id: None,
        message_id: None,
    };
    crate::notify::show(
        &app,
        crate::notify::SEND_ERROR_NOTIFICATION_ID,
        "Couldn't send message".to_string(),
        error,
        target,
    );
    Ok(())
}
```

Zwrócenie `Ok(())` dla `None` zachowuje istniejące zachowanie: powiadomienia powstają tylko dla folderów typu Inbox.

- [ ] **Step 5: Zarejestruj komendy i event**

W `crates/am-app/src/lib.rs` dopisz do `collect_commands![…]`, bezpośrednio po `commands::build_new_mail_notification`:

```rust
            commands::show_new_mail_notification,
            commands::show_send_error_notification,
```

oraz do `collect_events![…]`, po `events::SendSucceeded`:

```rust
            events::NotificationActivated,
```

- [ ] **Step 6: Zbuduj całość i uruchom testy**

Run: `cargo test -p am-app`
Expected: PASS — teraz kompiluje się także `notify::show` z Task 3.

- [ ] **Step 7: Commit**

```bash
git add crates/am-app/src/events.rs crates/am-app/src/commands.rs crates/am-app/src/lib.rs crates/am-app/src/notify.rs
git commit -m "feat(notifications): add activation event and notification commands"
```

---

### Task 5: Przełączenie frontendu na komendy

**Files:**
- Modify: `src/ipc/bindings.ts` (generowany — nie edytuj ręcznie)
- Modify: `src/ipc/events.ts:8-16` oraz `:71-80`
- Test: `src/ipc/events.test.tsx`

**Interfaces:**
- Consumes: `commands.showNewMailNotification(accountId, folderId, count)`, `commands.showSendErrorNotification(error)` (Task 4)

- [ ] **Step 1: Zregeneruj bindings**

```bash
nvm use 24
npm run gen:bindings
```

Expected: `src/ipc/bindings.ts` zawiera `showNewMailNotification`, `showSendErrorNotification` oraz typ `NotificationActivated`. Sprawdź: `rg -n "showNewMailNotification|NotificationActivated" src/ipc/bindings.ts`

- [ ] **Step 2: Przestaw mocki i asercje w teście**

W `src/ipc/events.test.tsx`, w bloku `vi.hoisted`, zamień `sendNotification: vi.fn(),` na:

```ts
  showNewMailNotification: vi.fn(),
  showSendErrorNotification: vi.fn(),
```

W `vi.mock("./bindings", …)` dopisz do obiektu `commands`:

```ts
    showNewMailNotification: h.showNewMailNotification,
    showSendErrorNotification: h.showSendErrorNotification,
```

oraz do obiektu `events`:

```ts
    notificationActivated: { listen: vi.fn().mockResolvedValue(() => {}) },
```

W mocku `@tauri-apps/plugin-notification` usuń linię `sendNotification: h.sendNotification,` — zostaje samo `isPermissionGranted`.

Zamień asercję w teście powiadomienia o nowej poczcie:

```ts
    await waitFor(() => expect(h.sendNotification).toHaveBeenCalledWith({ title: "Alice", body: "Hi" }));
```
→
```ts
    await waitFor(() => expect(h.showNewMailNotification).toHaveBeenCalledWith(1, 2, 1));
```

Dopasuj argumenty `(account_id, folder_id, count)` do payloadu, którym test karmi `h.newMessagesCb`. Pozostałe asercje `expect(h.sendNotification).not.toHaveBeenCalled()` zamień na `expect(h.showNewMailNotification).not.toHaveBeenCalled()`.

- [ ] **Step 3: Uruchom testy i potwierdź, że failują**

Run: `npx vitest run src/ipc/events.test.tsx`
Expected: FAIL — `showNewMailNotification` nie został wywołany (kod nadal woła `sendNotification`).

- [ ] **Step 4: Przepnij events.ts na komendy**

W `src/ipc/events.ts` zamień funkcję `maybeNotifyNewMail` na:

```ts
async function maybeNotifyNewMail(payload: { account_id: number; folder_id: number; count: number }) {
  if (!useUiStore.getState().notificationsEnabled) return;
  if (await getCurrentWindow().isFocused()) return;
  if (!(await isPermissionGranted())) return;
  await commands.showNewMailNotification(payload.account_id, payload.folder_id, payload.count);
}
```

W handlerze `events.sendFailed.listen` zamień blok wysyłki na:

```ts
      if (await isPermissionGranted()) {
        void commands.showSendErrorNotification(event.payload.error);
      }
```

Popraw import w linii 4 — `sendNotification` nie jest już używane:

```ts
import { isPermissionGranted } from "@tauri-apps/plugin-notification";
```

- [ ] **Step 5: Uruchom testy i potwierdź, że przechodzą**

Run: `npx vitest run src/ipc/events.test.tsx`
Expected: PASS

- [ ] **Step 6: Sprawdź typy — vitest ich NIE sprawdza**

Run: `npx tsc --noEmit`
Expected: brak błędów.

Ten krok jest obowiązkowy: vitest transpiluje bez kontroli typów, więc zielone testy nie dowodzą, że projekt się zbuduje. Konkretna pułapka w tym zadaniu — sygnatura `maybeNotifyNewMail` deklaruje `{ folder_id, count }`, a po zmianie przekazujesz też `payload.account_id`; rozszerz ją na `{ account_id: number; folder_id: number; count: number }`, inaczej `tsc` wywali `TS2339` dopiero w `tauri build`.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/bindings.ts src/ipc/events.ts src/ipc/events.test.tsx
git commit -m "feat(notifications): send notifications through backend commands"
```

---

### Task 6: Nawigacja po aktywacji powiadomienia

**Files:**
- Modify: `src/ipc/events.ts`
- Test: `src/ipc/events.test.tsx`

**Interfaces:**
- Consumes: `events.notificationActivated` (Task 4), `useUiStore` (`setSelectedAccountId`, `setSelectedFolderId`, `selectRow`, `selectMode`)

**Kontekst decyzyjny:** store nie ma jednej przestrzeni identyfikatorów. `selectRow(id)` (`src/app/store.ts:379`) rozgałęzia się po `selectMode`: w trybie `"thread"` ustawia `selectedThreadId`, w przeciwnym razie `selectedMessageId`. Dlatego handler musi wybrać `thread_id` albo `message_id` zależnie od trybu. Dodatkowo `setSelectedFolderId` **czyści** zaznaczenie (`selectedMessageId: null`, `selectedRowIds: []`), więc kolejność wywołań ma znaczenie: najpierw folder, potem wiersz.

- [ ] **Step 1: Napisz failujące testy**

W `src/ipc/events.test.tsx` dopisz przechwycenie callbacku w `vi.hoisted`:

```ts
  notificationActivatedCb: null as ((e: { payload: { account_id: number | null; folder_id: number | null; thread_id: number | null; message_id: number | null } }) => void) | null,
```

i podmień mock listenera w obiekcie `events`:

```ts
    notificationActivated: {
      listen: vi.fn((cb) => {
        h.notificationActivatedCb = cb;
        return Promise.resolve(() => {});
      }),
    },
```

Następnie dopisz testy:

```ts
  it("navigates to the notified message in thread mode", async () => {
    useUiStore.setState({ selectMode: "thread" });
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.notificationActivatedCb).not.toBeNull());

    h.notificationActivatedCb!({
      payload: { account_id: 5, folder_id: 9, thread_id: 42, message_id: 77 },
    });

    await waitFor(() => {
      const s = useUiStore.getState();
      expect(s.selectedAccountId).toBe(5);
      expect(s.selectedFolderId).toBe(9);
      expect(s.selectedThreadId).toBe(42);
    });
  });

  it("navigates by message id outside thread mode", async () => {
    useUiStore.setState({ selectMode: "message" });
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.notificationActivatedCb).not.toBeNull());

    h.notificationActivatedCb!({
      payload: { account_id: 5, folder_id: 9, thread_id: 42, message_id: 77 },
    });

    await waitFor(() => {
      const s = useUiStore.getState();
      expect(s.selectedFolderId).toBe(9);
      expect(s.selectedMessageId).toBe(77);
    });
  });

  it("leaves navigation untouched for a focus-only activation", async () => {
    useUiStore.setState({ selectedAccountId: 1, selectedFolderId: 2 });
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.notificationActivatedCb).not.toBeNull());

    h.notificationActivatedCb!({
      payload: { account_id: null, folder_id: null, thread_id: null, message_id: null },
    });

    const s = useUiStore.getState();
    expect(s.selectedAccountId).toBe(1);
    expect(s.selectedFolderId).toBe(2);
  });
```

Nazwy trybów są zweryfikowane: `selectMode: "thread" | "message"` (`src/app/store.ts:81`), domyślnie `"thread"` (`:214`).

- [ ] **Step 2: Uruchom testy i potwierdź, że failują**

Run: `npx vitest run src/ipc/events.test.tsx`
Expected: FAIL — nawigacja się nie zmienia, bo handler jeszcze nie istnieje.

- [ ] **Step 3: Zaimplementuj handler**

W `src/ipc/events.ts` dopisz funkcję nawigacji nad `useSyncEvents`:

```ts
function navigateToNotificationTarget(payload: {
  account_id: number | null;
  folder_id: number | null;
  thread_id: number | null;
  message_id: number | null;
}) {
  if (payload.account_id == null || payload.folder_id == null) return;
  const store = useUiStore.getState();
  store.setSelectedAccountId(payload.account_id);
  store.setSelectedFolderId(payload.folder_id);
  const rowId = store.selectMode === "thread" ? payload.thread_id : payload.message_id;
  if (rowId == null) return;
  useUiStore.getState().selectRow(rowId);
}
```

Trzy rozstrzygnięcia zapisane w tym kodzie:

1. Aktywacja „tylko focus" (błąd wysyłki, wszystkie pola `null`) wychodzi natychmiast — okno zostało już podniesione po stronie Rusta, widok pozostaje nietknięty.
2. Identyfikator wiersza pochodzi wyłącznie z przestrzeni pasującej do `selectMode`. Gdy właściwy jest `null`, zaznaczenie zostaje **odpuszczone** — sięgnięcie po zapasowy wpisałoby identyfikator z obcej przestrzeni i zaznaczyło niewłaściwy wiersz.
3. Kolejność wynika z efektów ubocznych store: konto, potem folder (czyści zaznaczenie), a zaznaczenie wiersza dopiero na końcu, żeby przetrwało.

Następnie podepnij listener wewnątrz `useEffect`, obok pozostałych, pamiętając o dopisaniu jego `unlisten` do funkcji sprzątającej:

```ts
    const notificationActivatedPromise = events.notificationActivated.listen((event) => {
      navigateToNotificationTarget(event.payload);
    });
```

```ts
      notificationActivatedPromise.then((unlisten) => unlisten());
```

- [ ] **Step 4: Uruchom testy i potwierdź, że przechodzą**

Run: `npx vitest run src/ipc/events.test.tsx`
Expected: PASS

- [ ] **Step 5: Uruchom pełny zestaw i porównaj z bazą**

Run: `npx vitest run`
Expected: 12 znanych faili i ani jednego więcej. Jeśli pojawi się trzynasty — to regresja z tej zmiany, napraw przed commitem.

- [ ] **Step 6: Commit**

```bash
git add src/ipc/events.ts src/ipc/events.test.tsx
git commit -m "feat(notifications): navigate to notified message on activation"
```

---

### Task 7: Weryfikacja manualna na docelowym środowisku

Jedyny sposób sprawdzenia realnego kliknięcia. Testy jednostkowe nie sięgają D-Bus.

**Files:** brak zmian

- [ ] **Step 1: Zbuduj paczkę produkcyjną**

```bash
nvm use 24
npx tauri build --no-bundle
```

Buduj przez `tauri build`, nie `cargo build` — samo `cargo build` daje tryb deweloperski wskazujący na `devUrl`, co w tym repo już raz zmyliło diagnozę.

- [ ] **Step 2: Uruchom monitor D-Bus jako świadka**

```bash
gdbus monitor --session --dest org.freedesktop.Notifications
```

- [ ] **Step 3: Uruchom aplikację, zejdź z fokusu i doprowadź do powiadomienia**

Uruchom zbudowany binarny plik, przełącz się na inne okno (powiadomienia są tłumione, gdy okno ma fokus) i poczekaj na przychodzącą pocztę albo wyślij wiadomość testową na konto podpięte w aplikacji.

- [ ] **Step 4: Kliknij w treść powiadomienia i zweryfikuj oba efekty**

Expected w monitorze: `ActionInvoked (…, 'default')`
Expected w aplikacji: okno podnosi się i otrzymuje fokus, a widok przechodzi na właściwe konto i folder; dla pojedynczej wiadomości zostaje ona otwarta.

- [ ] **Step 5: Sprawdź scenariusz traya**

Włącz tray w ustawieniach, zamknij okno (chowa się zamiast zamykać), doprowadź do powiadomienia i kliknij. Expected: ukryte okno wraca.

- [ ] **Step 6: Sprawdź zastępowanie powiadomień**

Doprowadź do dwóch powiadomień o poczcie pod rząd. Expected: drugie zastępuje pierwsze zamiast dokładać się do listy — to celowy skutek stałego id i sufit oczekujących wątków.

---

## Poza zakresem

- Weryfikacja kliknięcia na Windows i macOS — kod jest wspólny, ale sprawdzony zostanie wyłącznie Linux.
- Naprawa 12 znanych faili vitest.
- Usunięcie `tauri-plugin-notification` — zostaje dla API uprawnień.
