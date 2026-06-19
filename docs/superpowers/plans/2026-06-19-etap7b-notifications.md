# Etap 7b Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop OS notifications for new incoming mail (INBOX only, when window unfocused) plus an unread-inbox badge on the app icon, with a Settings → Notifications section.

**Architecture:** Testable logic (INBOX filter + notification content + unread count) lives in `am-storage`; two thin `am-app` commands expose it; the OS orchestration (settings gate, window-focus check, `sendNotification`, badge set) lives in the frontend where that state naturally resides. `NewMessages` (emitted only by `incremental_sync_folder`, never by the initial full sync) is the trigger. Zero migration — settings on V6 keys.

**Tech Stack:** Rust (rusqlite), Tauri 2.11 (`tauri-plugin-notification`, `WebviewWindow::set_badge_count`), `@tauri-apps/plugin-notification`, React 19/TS, @tanstack/react-query v5, zustand, vitest + @testing-library/react + happy-dom.

## Global Constraints

- All code identifiers in English; ZERO comments in source code (including test files — no `//`).
- Conventional Commits 1.0.0; do NOT add yourself as co-author; push ONLY when explicitly asked.
- Never `git add .` — stage only explicitly named paths (a gitignored OAuth secret must never be committed).
- ZERO migration — notification settings persist on V6 settings keys `notifications.enabled` / `notifications.badge`.
- Scope: notifications and badge cover ONLY folders of type Inbox (`folder_type = 'inbox'`); Sent/Drafts/Spam/Trash/Archive ignored.
- Notifications suppressed when the app window is focused.
- Content: `count == 1` → title = sender (from_name, fallback from_address), body = subject (fallback "(no subject)"); `count > 1` → title = account email, body = "{count} new messages".
- Insertion/orchestration is frontend; `am-sync` / `build_prefill` / the `NewMessages` event MUST stay unchanged.
- Default settings: notifications ON, badge ON (notifications still gated by OS permission).
- Test-infra: new lucide icons used in app code MUST be added to `src/test/lucide-stub.js` (else vitest OOM); `.toBeTruthy()`/`.toBeNull()` (no jest-dom); tsconfig has `noUnusedLocals`/`noUnusedParameters` ON so unused imports/locals break `npm run build` (vitest does NOT typecheck); new commands/hooks/store fields go into the mocks in `src/app/AppShell.test.tsx` if a full `npx vitest run` requires them.
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`; frontend tests `npx vitest run`, build `npm run build`, bindings `npm run gen:bindings`.

---

## File Structure

- `crates/am-core/src/notification.rs` — **Create**: `NotificationContent` type. + register `pub mod notification;` (Task 1).
- `crates/am-storage/src/notifications_repo.rs` — **Create**: `build_new_mail_notification` + `count_inbox_unread` + tests. + register `pub mod notifications_repo;` (Task 1).
- `crates/am-app/src/commands.rs` — **Modify**: two commands (Task 2).
- `crates/am-app/src/lib.rs` — **Modify**: register commands (Task 2).
- `src-tauri/Cargo.toml` — **Modify**: add `tauri-plugin-notification` (Task 2).
- `src-tauri/src/lib.rs` — **Modify**: `.plugin(tauri_plugin_notification::init())` (Task 2).
- `src-tauri/capabilities/default.json` — **Modify**: add `notification:default` (Task 2).
- `src/ipc/bindings.ts` — **Regenerated** (Task 2).
- `package.json` / `package-lock.json` — **Modify**: add `@tauri-apps/plugin-notification` (Task 3).
- `src/shared/notifications/notifications.ts` — **Create**: keys/defaults/parse (Task 3).
- `src/shared/notifications/NotificationsProvider.tsx` — **Create**: provider + `useNotifications` (Task 3).
- `src/shared/notifications/NotificationsProvider.test.tsx` — **Create** (Task 3).
- `src/app/store.ts` — **Modify**: notification fields + setters + `hydrateNotifications` (Task 3).
- `src/main.tsx` — **Modify**: mount `NotificationsProvider` (Task 3).
- `src/features/settings/NotificationsSection.tsx` — **Create** (Task 4).
- `src/features/settings/NotificationsSection.test.tsx` — **Create** (Task 4).
- `src/features/settings/SettingsOverlay.tsx` — **Modify**: mount under `notifications` id (Task 4).
- `src/ipc/events.ts` — **Modify**: notify + badge refresh (Task 5).
- `src/ipc/events.test.tsx` — **Create** (Task 5).
- `src/ipc/queries.ts` — **Modify**: badge refresh in `useMarkSeen`/`useSetFlag` onSuccess (Task 5).

---

## Task 1: Rust — NotificationContent + notifications_repo

**Files:**
- Create: `crates/am-core/src/notification.rs`
- Modify: `crates/am-core/src/lib.rs`
- Create: `crates/am-storage/src/notifications_repo.rs`
- Modify: `crates/am-storage/src/lib.rs`

**Interfaces:**
- Consumes: `crate::db::{Database, StorageError}`; `rusqlite::{params, OptionalExtension}`; existing `accounts_repo::insert_account`, `folders_repo::{upsert_folder, set_counts}`, `messages_repo::insert_headers`, `am_core::account::{NewAccount, ProviderType}`, `am_core::folder::FolderType`, `am_core::message::NewMessageHeader` (tests).
- Produces:
  - `am_core::notification::NotificationContent { title: String, body: String }` (serde + specta::Type)
  - `notifications_repo::build_new_mail_notification(db: &Database, folder_id: i64, count: i64) -> Result<Option<NotificationContent>, StorageError>`
  - `notifications_repo::count_inbox_unread(db: &Database) -> Result<i64, StorageError>`

- [ ] **Step 1: Create the NotificationContent type**

Create `crates/am-core/src/notification.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct NotificationContent {
    pub title: String,
    pub body: String,
}
```

In `crates/am-core/src/lib.rs` add (keeping alphabetical grouping, after `pub mod message;`):

```rust
pub mod notification;
```

- [ ] **Step 2: Register the storage module and write the failing tests**

In `crates/am-storage/src/lib.rs` add (after `pub mod messages_repo;`):

```rust
pub mod notifications_repo;
```

Create `crates/am-storage/src/notifications_repo.rs` with ONLY the test module first (the production code comes in Step 4):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use crate::folders_repo::{set_counts, upsert_folder};
    use crate::messages_repo::insert_headers;
    use am_core::account::{NewAccount, ProviderType};
    use am_core::folder::FolderType;
    use am_core::message::NewMessageHeader;

    fn make_account(db: &Database, email: &str) -> i64 {
        insert_account(db, &NewAccount {
            email: email.into(),
            display_name: email.into(),
            provider_type: ProviderType::ImapPassword,
            color: None,
        }).unwrap().id
    }

    fn make_folder(db: &Database, account_id: i64, name: &str, ft: FolderType) -> i64 {
        upsert_folder(db, account_id, name, name, ft).unwrap().id
    }

    fn header(uid: i64, from_name: Option<&str>, from_address: &str, subject: &str, date: i64) -> NewMessageHeader {
        NewMessageHeader {
            uid,
            message_id_hdr: Some(format!("<msg-{uid}@example.com>")),
            in_reply_to: None,
            references_hdr: None,
            from_address: from_address.into(),
            from_name: from_name.map(|s| s.to_string()),
            subject: subject.into(),
            date,
            seen: false,
            flagged: false,
            has_attachments: false,
            size: 100,
            snippet: "preview".into(),
        }
    }

    #[test]
    fn non_inbox_folder_returns_none() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let sent = make_folder(&db, acc, "Sent", FolderType::Sent);
        insert_headers(&db, sent, &[header(1, Some("X"), "x@example.com", "Hi", 1000)]).unwrap();
        assert!(build_new_mail_notification(&db, sent, 1).unwrap().is_none());
    }

    #[test]
    fn single_uses_sender_name_and_subject() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, Some("Alice"), "alice@example.com", "Lunch?", 1000)]).unwrap();
        let n = build_new_mail_notification(&db, inbox, 1).unwrap().unwrap();
        assert_eq!(n.title, "Alice");
        assert_eq!(n.body, "Lunch?");
    }

    #[test]
    fn single_falls_back_to_address_when_name_empty() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, None, "bob@example.com", "Re: project", 1000)]).unwrap();
        let n = build_new_mail_notification(&db, inbox, 1).unwrap().unwrap();
        assert_eq!(n.title, "bob@example.com");
        assert_eq!(n.body, "Re: project");
    }

    #[test]
    fn single_falls_back_to_no_subject() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "a@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[header(1, Some("Carol"), "carol@example.com", "", 1000)]).unwrap();
        let n = build_new_mail_notification(&db, inbox, 1).unwrap().unwrap();
        assert_eq!(n.title, "Carol");
        assert_eq!(n.body, "(no subject)");
    }

    #[test]
    fn multiple_aggregates_with_count_and_account_email() {
        let db = Database::open_in_memory().unwrap();
        let acc = make_account(&db, "me@example.com");
        let inbox = make_folder(&db, acc, "INBOX", FolderType::Inbox);
        insert_headers(&db, inbox, &[
            header(1, Some("A"), "a@example.com", "One", 1000),
            header(2, Some("B"), "b@example.com", "Two", 2000),
            header(3, Some("C"), "c@example.com", "Three", 3000),
        ]).unwrap();
        let n = build_new_mail_notification(&db, inbox, 3).unwrap().unwrap();
        assert_eq!(n.title, "me@example.com");
        assert_eq!(n.body, "3 new messages");
    }

    #[test]
    fn count_inbox_unread_sums_inbox_folders_only() {
        let db = Database::open_in_memory().unwrap();
        let acc1 = make_account(&db, "a@example.com");
        let acc2 = make_account(&db, "b@example.com");
        let in1 = make_folder(&db, acc1, "INBOX", FolderType::Inbox);
        let in2 = make_folder(&db, acc2, "INBOX", FolderType::Inbox);
        let spam = make_folder(&db, acc1, "Spam", FolderType::Spam);
        set_counts(&db, in1, 3, 10).unwrap();
        set_counts(&db, in2, 4, 12).unwrap();
        set_counts(&db, spam, 9, 9).unwrap();
        assert_eq!(count_inbox_unread(&db).unwrap(), 7);
    }

    #[test]
    fn count_inbox_unread_zero_when_no_inbox() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(count_inbox_unread(&db).unwrap(), 0);
    }
}
```

- [ ] **Step 3: Run the tests — must FAIL**

```bash
cargo test -p am-storage --lib notifications_repo
```
Expected: FAIL — `cannot find function build_new_mail_notification` / `count_inbox_unread`.

- [ ] **Step 4: Implement the production code**

Prepend to `crates/am-storage/src/notifications_repo.rs` (above the `#[cfg(test)]` module):

```rust
use am_core::notification::NotificationContent;
use rusqlite::{params, OptionalExtension};

use crate::db::{Database, StorageError};

pub fn build_new_mail_notification(
    db: &Database,
    folder_id: i64,
    count: i64,
) -> Result<Option<NotificationContent>, StorageError> {
    let conn = db.conn();
    let folder_type: Option<String> = conn
        .query_row(
            "SELECT folder_type FROM folders WHERE id = ?1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(folder_type) = folder_type else {
        return Ok(None);
    };
    if folder_type != "inbox" {
        return Ok(None);
    }
    if count == 1 {
        let row: Option<(Option<String>, String, String)> = conn
            .query_row(
                "SELECT from_name, from_address, subject FROM messages
                 WHERE folder_id = ?1 AND draft = 0 AND deleted = 0
                 ORDER BY date DESC LIMIT 1",
                params![folder_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((from_name, from_address, subject)) = row else {
            return Ok(None);
        };
        let title = match from_name {
            Some(n) if !n.trim().is_empty() => n,
            _ => from_address,
        };
        let body = if subject.trim().is_empty() {
            "(no subject)".to_string()
        } else {
            subject
        };
        Ok(Some(NotificationContent { title, body }))
    } else {
        let email: Option<String> = conn
            .query_row(
                "SELECT a.email FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ?1",
                params![folder_id],
                |r| r.get(0),
            )
            .optional()?;
        let title = email.unwrap_or_else(|| "AbeonMail".to_string());
        Ok(Some(NotificationContent {
            title,
            body: format!("{count} new messages"),
        }))
    }
}

pub fn count_inbox_unread(db: &Database) -> Result<i64, StorageError> {
    let conn = db.conn();
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(unread_count), 0) FROM folders WHERE folder_type = 'inbox'",
        [],
        |r| r.get(0),
    )?;
    Ok(total)
}
```

- [ ] **Step 5: Run the tests — must PASS**

```bash
cargo test -p am-storage --lib notifications_repo
```
Expected: PASS — 7 tests green.

- [ ] **Step 6: Commit**

```bash
git add crates/am-core/src/notification.rs crates/am-core/src/lib.rs crates/am-storage/src/notifications_repo.rs crates/am-storage/src/lib.rs
git commit -m "feat(notifications): add notification content + inbox unread repo"
```

---

## Task 2: Rust — commands + notification plugin + badge

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Regenerated: `src/ipc/bindings.ts`

**Interfaces:**
- Consumes: `notifications_repo::{build_new_mail_notification, count_inbox_unread}` (Task 1); `am_core::notification::NotificationContent`; `AppState` (`state.db`); `tauri::AppHandle`; `tauri::Manager` (for `get_webview_window`); `WebviewWindow::set_badge_count(Option<i64>)`.
- Produces (bindings camelCase):
  - `build_new_mail_notification(folder_id: i64, count: i64) -> Result<Option<NotificationContent>, String>` → `commands.buildNewMailNotification(folderId, count)`
  - `refresh_unread_badge(enabled: bool) -> Result<(), String>` → `commands.refreshUnreadBadge(enabled)`

This task is thin IPC + plugin wiring; no Rust unit test (commands take `tauri::State`/`AppHandle`, logic covered by Task 1). Gate: compiles, bindings regenerate, both commands + the `NotificationContent` type appear in bindings.

- [ ] **Step 1: Add the commands in `crates/am-app/src/commands.rs`**

At the top of the file, extend the existing `am_core` and `am_storage` use-groups: add `notification::NotificationContent` to the `am_core::{...}` import, and `notifications_repo` to the `am_storage::{...}` import.

Add these commands (place after the existing signature commands, before `guess_mime_from_extension`):

```rust
#[tauri::command]
#[specta::specta]
pub fn build_new_mail_notification(
    state: tauri::State<'_, AppState>,
    folder_id: i64,
    count: i64,
) -> Result<Option<NotificationContent>, String> {
    notifications_repo::build_new_mail_notification(&state.db, folder_id, count)
        .map_err(|_| "Failed to build notification".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn refresh_unread_badge(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    use tauri::Manager;
    let count = if enabled {
        notifications_repo::count_inbox_unread(&state.db)
            .map_err(|_| "Failed to count unread".to_string())?
    } else {
        0
    };
    if let Some(window) = app.get_webview_window("main") {
        let badge = if count > 0 { Some(count) } else { None };
        let _ = window.set_badge_count(badge);
    }
    Ok(())
}
```

- [ ] **Step 2: Register the commands in `crates/am-app/src/lib.rs`**

In `collect_commands![ ... ]`, after `commands::unsnooze_messages,`:

```rust
            commands::build_new_mail_notification,
            commands::refresh_unread_badge,
```

- [ ] **Step 3: Add the notification plugin dependency**

In `src-tauri/Cargo.toml`, in `[dependencies]`, after `tauri-plugin-dialog = "2"`:

```toml
tauri-plugin-notification = "2"
```

In `src-tauri/src/lib.rs`, add the plugin to the builder chain after `.plugin(tauri_plugin_dialog::init())`:

```rust
        .plugin(tauri_plugin_notification::init())
```

In `src-tauri/capabilities/default.json`, add `"notification:default"` to the `permissions` array (after `"dialog:default"`):

```json
    "notification:default"
```

- [ ] **Step 4: Build — must compile**

```bash
cargo build -p abeonmail
```
Expected: compiles without errors (the `notification:default` capability resolves because the plugin crate is now a dependency).

- [ ] **Step 5: Regenerate bindings and confirm**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm run gen:bindings
grep -E "buildNewMailNotification|refreshUnreadBadge|NotificationContent" src/ipc/bindings.ts
```
Expected: both commands and the `NotificationContent` type appear.

- [ ] **Step 6: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/capabilities/default.json src/ipc/bindings.ts Cargo.lock
git commit -m "feat(notifications): commands + notification plugin + badge wiring"
```

---

## Task 3: Frontend — settings layer (notifications.ts + store + provider)

**Files:**
- Modify: `package.json`, `package-lock.json` (add `@tauri-apps/plugin-notification`)
- Create: `src/shared/notifications/notifications.ts`
- Modify: `src/app/store.ts`
- Create: `src/shared/notifications/NotificationsProvider.tsx`
- Create: `src/shared/notifications/NotificationsProvider.test.tsx`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `commands.{getSettings, setSetting, refreshUnreadBadge}`; `useUiStore`; `isPermissionGranted`, `requestPermission` from `@tauri-apps/plugin-notification`.
- Produces:
  - `notifications.ts`: `NotificationFields`, `NOTIFICATION_KEYS`, `DEFAULT_NOTIFICATIONS`, `parseNotificationSettings(pairs)`.
  - store fields `notificationsEnabled: boolean`, `badgeEnabled: boolean` + setters `setNotificationsEnabled`/`setBadgeEnabled` + `hydrateNotifications(partial)`.
  - `NotificationsProvider` + `useNotifications()` → `{ notificationsEnabled, badgeEnabled, permissionGranted, setNotificationsEnabled, setBadgeEnabled }`.

- [ ] **Step 1: Install the JS plugin package**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm install @tauri-apps/plugin-notification@^2
```
Expected: package added to `package.json` dependencies.

- [ ] **Step 2: Create `src/shared/notifications/notifications.ts`**

```ts
export type NotificationFields = {
  notificationsEnabled: boolean;
  badgeEnabled: boolean;
};

export const NOTIFICATION_KEYS = {
  notificationsEnabled: "notifications.enabled",
  badgeEnabled: "notifications.badge",
} as const;

export const DEFAULT_NOTIFICATIONS: NotificationFields = {
  notificationsEnabled: true,
  badgeEnabled: true,
};

export function parseNotificationSettings(pairs: [string, string][]): Partial<NotificationFields> {
  const out: Partial<NotificationFields> = {};
  for (const [key, value] of pairs) {
    if (key === NOTIFICATION_KEYS.notificationsEnabled && (value === "true" || value === "false")) {
      out.notificationsEnabled = value === "true";
    } else if (key === NOTIFICATION_KEYS.badgeEnabled && (value === "true" || value === "false")) {
      out.badgeEnabled = value === "true";
    }
  }
  return out;
}
```

- [ ] **Step 3: Add store fields and setters in `src/app/store.ts`**

Add to the `UiState` type (near the appearance fields):

```ts
  notificationsEnabled: boolean;
  badgeEnabled: boolean;
```

Add to the actions section of the type:

```ts
  setNotificationsEnabled: (value: boolean) => void;
  setBadgeEnabled: (value: boolean) => void;
  hydrateNotifications: (partial: Partial<{ notificationsEnabled: boolean; badgeEnabled: boolean }>) => void;
```

Add the import near the appearance import:

```ts
import { DEFAULT_NOTIFICATIONS } from "../shared/notifications/notifications";
```

Add to the initial state (near `showAvatars: DEFAULT_APPEARANCE.showAvatars,`):

```ts
  notificationsEnabled: DEFAULT_NOTIFICATIONS.notificationsEnabled,
  badgeEnabled: DEFAULT_NOTIFICATIONS.badgeEnabled,
```

Add to the actions implementation (near `hydrateAppearance`):

```ts
  setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
  setBadgeEnabled: (badgeEnabled) => set({ badgeEnabled }),
  hydrateNotifications: (partial) => set(partial),
```

- [ ] **Step 4: Write the failing provider test**

Create `src/shared/notifications/NotificationsProvider.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { NotificationsProvider, useNotifications } from "./NotificationsProvider";

const { mockIsGranted, mockRequest } = vi.hoisted(() => ({
  mockIsGranted: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({
      status: "ok",
      data: [["notifications.badge", "false"]],
    }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    refreshUnreadBadge: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mockIsGranted,
  requestPermission: mockRequest,
}));

function wrapper({ children }: { children: ReactNode }) {
  return <NotificationsProvider>{children}</NotificationsProvider>;
}

describe("NotificationsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGranted.mockResolvedValue(true);
    mockRequest.mockResolvedValue("granted");
    useUiStore.setState({ notificationsEnabled: true, badgeEnabled: true });
  });
  afterEach(() => cleanup());

  it("hydrates from settings", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.badgeEnabled).toBe(false));
    expect(result.current.notificationsEnabled).toBe(true);
  });

  it("requests OS permission when enabled and not yet granted", async () => {
    mockIsGranted.mockResolvedValue(false);
    renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
  });

  it("persists a toggle and updates the store", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.badgeEnabled).toBe(false));
    act(() => result.current.setNotificationsEnabled(false));
    await waitFor(() =>
      expect(commands.setSetting).toHaveBeenCalledWith("notifications.enabled", "false"),
    );
    expect(useUiStore.getState().notificationsEnabled).toBe(false);
  });

  it("refreshes the badge when badge setting changes", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(commands.refreshUnreadBadge).toHaveBeenCalled());
    act(() => result.current.setBadgeEnabled(true));
    await waitFor(() => expect(commands.refreshUnreadBadge).toHaveBeenCalledWith(true));
  });
});
```

- [ ] **Step 5: Run the test — must FAIL**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/shared/notifications/NotificationsProvider.test.tsx
```
Expected: FAIL — `NotificationsProvider` does not exist.

- [ ] **Step 6: Implement `src/shared/notifications/NotificationsProvider.tsx`**

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { NOTIFICATION_KEYS, parseNotificationSettings } from "./notifications";

type NotificationsContextValue = {
  notificationsEnabled: boolean;
  badgeEnabled: boolean;
  permissionGranted: boolean;
  setNotificationsEnabled: (value: boolean) => void;
  setBadgeEnabled: (value: boolean) => void;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

function persist(key: string, value: string) {
  void commands.setSetting(key, value).catch(() => undefined);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const notificationsEnabled = useUiStore((s) => s.notificationsEnabled);
  const badgeEnabled = useUiStore((s) => s.badgeEnabled);
  const hydrateNotifications = useUiStore((s) => s.hydrateNotifications);
  const storeSetNotificationsEnabled = useUiStore((s) => s.setNotificationsEnabled);
  const storeSetBadgeEnabled = useUiStore((s) => s.setBadgeEnabled);
  const [permissionGranted, setPermissionGranted] = useState(true);

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (active && res.status === "ok") {
          hydrateNotifications(parseNotificationSettings(res.data));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrateNotifications]);

  useEffect(() => {
    if (!notificationsEnabled) return;
    let active = true;
    (async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      if (active) setPermissionGranted(granted);
    })();
    return () => {
      active = false;
    };
  }, [notificationsEnabled]);

  useEffect(() => {
    void commands.refreshUnreadBadge(badgeEnabled).catch(() => undefined);
  }, [badgeEnabled]);

  const value = useMemo<NotificationsContextValue>(
    () => ({
      notificationsEnabled,
      badgeEnabled,
      permissionGranted,
      setNotificationsEnabled: (v) => {
        storeSetNotificationsEnabled(v);
        persist(NOTIFICATION_KEYS.notificationsEnabled, String(v));
      },
      setBadgeEnabled: (v) => {
        storeSetBadgeEnabled(v);
        persist(NOTIFICATION_KEYS.badgeEnabled, String(v));
      },
    }),
    [
      notificationsEnabled,
      badgeEnabled,
      permissionGranted,
      storeSetNotificationsEnabled,
      storeSetBadgeEnabled,
    ]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}
```

- [ ] **Step 7: Mount the provider in `src/main.tsx`**

Add the import:

```tsx
import { NotificationsProvider } from "./shared/notifications/NotificationsProvider";
```

Wrap inside `AppearanceProvider` (around `ShortcutsProvider`):

```tsx
      <AppearanceProvider>
        <NotificationsProvider>
          <ShortcutsProvider>
            <App />
          </ShortcutsProvider>
        </NotificationsProvider>
      </AppearanceProvider>
```

- [ ] **Step 8: Run the test — must PASS**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/shared/notifications/NotificationsProvider.test.tsx
```
Expected: PASS — 4/4.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/shared/notifications/notifications.ts src/shared/notifications/NotificationsProvider.tsx src/shared/notifications/NotificationsProvider.test.tsx src/app/store.ts src/main.tsx
git commit -m "feat(notifications): settings store + provider + permission"
```

---

## Task 4: Frontend — Settings → Notifications section

**Files:**
- Create: `src/features/settings/NotificationsSection.tsx`
- Create: `src/features/settings/NotificationsSection.test.tsx`
- Modify: `src/features/settings/SettingsOverlay.tsx`

**Interfaces:**
- Consumes: `useNotifications` (Task 3).
- Produces: `NotificationsSection` mounted under the `notifications` id in `SettingsOverlay`.

Note: the section uses a local `Toggle` component identical in markup to the one inlined in `AppearanceSection` (`div.appearance-toggle` + `button[role="switch"]`). This duplication is consistent with the existing per-section pattern (AppearanceSection inlines its own); do not refactor AppearanceSection.

- [ ] **Step 1: Write the failing test**

Create `src/features/settings/NotificationsSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { NotificationsSection } from "./NotificationsSection";

const { setNotificationsEnabled, setBadgeEnabled } = vi.hoisted(() => ({
  setNotificationsEnabled: vi.fn(),
  setBadgeEnabled: vi.fn(),
}));

vi.mock("../../shared/notifications/NotificationsProvider", () => ({
  useNotifications: () => ({
    notificationsEnabled: true,
    badgeEnabled: false,
    permissionGranted: true,
    setNotificationsEnabled,
    setBadgeEnabled,
  }),
}));

function wrap(ui: ReactNode) {
  return render(<>{ui}</>);
}

describe("NotificationsSection", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("renders both toggles reflecting current state", () => {
    const { getByLabelText } = wrap(<NotificationsSection />);
    expect(getByLabelText("Desktop notifications").getAttribute("aria-checked")).toBe("true");
    expect(getByLabelText("Unread badge").getAttribute("aria-checked")).toBe("false");
  });

  it("toggles desktop notifications", () => {
    const { getByLabelText } = wrap(<NotificationsSection />);
    fireEvent.click(getByLabelText("Desktop notifications"));
    expect(setNotificationsEnabled).toHaveBeenCalledWith(false);
  });

  it("toggles the unread badge", () => {
    const { getByLabelText } = wrap(<NotificationsSection />);
    fireEvent.click(getByLabelText("Unread badge"));
    expect(setBadgeEnabled).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run the test — must FAIL**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/features/settings/NotificationsSection.test.tsx
```
Expected: FAIL — `NotificationsSection` does not exist.

- [ ] **Step 3: Implement `src/features/settings/NotificationsSection.tsx`**

```tsx
import { useNotifications } from "../../shared/notifications/NotificationsProvider";

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="appearance-toggle">
      <div className="appearance-toggle__text">
        <div className="appearance-toggle__label">{label}</div>
        {hint && <div className="appearance-toggle__hint">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch${checked ? " switch--on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}

export function NotificationsSection() {
  const n = useNotifications();

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">
        Choose how AbeonMail alerts you to new mail on this device.
      </p>
      <Toggle
        label="Desktop notifications"
        hint="Show a system notification when new mail arrives while AbeonMail is in the background"
        checked={n.notificationsEnabled}
        onChange={n.setNotificationsEnabled}
      />
      <Toggle
        label="Unread badge"
        hint="Show the unread inbox count on the app icon"
        checked={n.badgeEnabled}
        onChange={n.setBadgeEnabled}
      />
      {n.notificationsEnabled && !n.permissionGranted && (
        <p className="appearance-section__intro" role="status">
          System notifications are blocked. Enable them in your operating system settings.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Mount in `src/features/settings/SettingsOverlay.tsx`**

Add the import:

```tsx
import { NotificationsSection } from "./NotificationsSection";
```

Add the branch (after the `signatures` branch, before `shortcuts`):

```tsx
          ) : active === "notifications" ? (
            <NotificationsSection />
```

- [ ] **Step 5: Run the tests — must PASS**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/features/settings/NotificationsSection.test.tsx src/features/settings/SettingsOverlay.test.tsx
```
Expected: PASS — NotificationsSection 3/3; SettingsOverlay no regression.

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/NotificationsSection.tsx src/features/settings/NotificationsSection.test.tsx src/features/settings/SettingsOverlay.tsx
git commit -m "feat(notifications): add Notifications settings section"
```

---

## Task 5: Frontend — events wiring (notify + badge refresh)

**Files:**
- Modify: `src/ipc/events.ts`
- Create: `src/ipc/events.test.tsx`
- Modify: `src/ipc/queries.ts`

**Interfaces:**
- Consumes: `commands.{buildNewMailNotification, refreshUnreadBadge}`; `useUiStore` (`notificationsEnabled`, `badgeEnabled`); `getCurrentWindow` from `@tauri-apps/api/window`; `isPermissionGranted`, `sendNotification` from `@tauri-apps/plugin-notification`.
- Produces: on `newMessages`, raise an OS notification (when enabled, window unfocused, permission granted) and refresh the badge; on `mailboxChanged`/`snoozeWoke`, refresh the badge; `useMarkSeen`/`useSetFlag` refresh the badge on success.

- [ ] **Step 1: Write the failing test**

Create `src/ipc/events.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUiStore } from "../app/store";
import { useSyncEvents } from "./events";

const h = vi.hoisted(() => ({
  newMessagesCb: null as ((e: { payload: { account_id: number; folder_id: number; count: number } }) => void) | null,
  sendNotification: vi.fn(),
  isFocused: vi.fn(),
  isPermissionGranted: vi.fn(),
  buildNewMailNotification: vi.fn(),
  refreshUnreadBadge: vi.fn(),
}));

vi.mock("./bindings", () => ({
  commands: {
    buildNewMailNotification: h.buildNewMailNotification,
    refreshUnreadBadge: h.refreshUnreadBadge,
  },
  events: {
    syncProgress: { listen: vi.fn().mockResolvedValue(() => {}) },
    newMessages: {
      listen: vi.fn((cb) => {
        h.newMessagesCb = cb;
        return Promise.resolve(() => {});
      }),
    },
    mailboxChanged: { listen: vi.fn().mockResolvedValue(() => {}) },
    accountAuthChanged: { listen: vi.fn().mockResolvedValue(() => {}) },
    snoozeWoke: { listen: vi.fn().mockResolvedValue(() => {}) },
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: h.isFocused }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: h.isPermissionGranted,
  sendNotification: h.sendNotification,
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useSyncEvents notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.newMessagesCb = null;
    h.isFocused.mockResolvedValue(false);
    h.isPermissionGranted.mockResolvedValue(true);
    h.buildNewMailNotification.mockResolvedValue({ status: "ok", data: { title: "Alice", body: "Hi" } });
    h.refreshUnreadBadge.mockResolvedValue({ status: "ok", data: null });
    useUiStore.setState({ notificationsEnabled: true, badgeEnabled: true });
  });
  afterEach(() => cleanup());

  it("notifies on new mail when unfocused and refreshes the badge", async () => {
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.newMessagesCb).not.toBeNull());
    h.newMessagesCb!({ payload: { account_id: 1, folder_id: 2, count: 1 } });
    await waitFor(() => expect(h.sendNotification).toHaveBeenCalledWith({ title: "Alice", body: "Hi" }));
    expect(h.buildNewMailNotification).toHaveBeenCalledWith(2, 1);
    await waitFor(() => expect(h.refreshUnreadBadge).toHaveBeenCalledWith(true));
  });

  it("does not notify when the window is focused", async () => {
    h.isFocused.mockResolvedValue(true);
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.newMessagesCb).not.toBeNull());
    h.newMessagesCb!({ payload: { account_id: 1, folder_id: 2, count: 1 } });
    await waitFor(() => expect(h.refreshUnreadBadge).toHaveBeenCalled());
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when notifications are disabled", async () => {
    useUiStore.setState({ notificationsEnabled: false, badgeEnabled: true });
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.newMessagesCb).not.toBeNull());
    h.newMessagesCb!({ payload: { account_id: 1, folder_id: 2, count: 1 } });
    await waitFor(() => expect(h.refreshUnreadBadge).toHaveBeenCalled());
    expect(h.buildNewMailNotification).not.toHaveBeenCalled();
    expect(h.sendNotification).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test — must FAIL**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/ipc/events.test.tsx
```
Expected: FAIL — `events.ts` does not yet import/call the notification APIs (e.g. `buildNewMailNotification` undefined / `sendNotification` never called).

- [ ] **Step 3: Implement the wiring in `src/ipc/events.ts`**

Replace the file's imports block with:

```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { commands, events } from "./bindings";
import { useUiStore } from "../app/store";
```

Add this helper above `useSyncEvents`:

```ts
async function maybeNotifyNewMail(payload: { folder_id: number; count: number }) {
  if (!useUiStore.getState().notificationsEnabled) return;
  if (await getCurrentWindow().isFocused()) return;
  if (!(await isPermissionGranted())) return;
  const res = await commands.buildNewMailNotification(payload.folder_id, payload.count);
  if (res.status === "ok" && res.data) {
    sendNotification({ title: res.data.title, body: res.data.body });
  }
}
```

In the `newMessages` listener, after the existing `invalidateQueries` calls, add:

```ts
      void maybeNotifyNewMail(event.payload);
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
```

In the `mailboxChanged` listener, after its `invalidateQueries` calls, add:

```ts
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
```

In the `snoozeWoke` listener, after its `invalidateQueries` calls, add:

```ts
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
```

- [ ] **Step 4: Add badge refresh to the seen/flag mutations in `src/ipc/queries.ts`**

In `useSetFlag`'s `onSuccess`, after the existing `invalidateQueries` calls, add:

```ts
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
```

In `useMarkSeen`'s `onSuccess`, after the existing `invalidateQueries` calls, add:

```ts
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
```

(`useUiStore` and `commands` are already imported in `queries.ts`.)

- [ ] **Step 5: Run the test — must PASS**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/ipc/events.test.tsx
```
Expected: PASS — 3/3.

- [ ] **Step 6: Commit**

```bash
git add src/ipc/events.ts src/ipc/events.test.tsx src/ipc/queries.ts
git commit -m "feat(notifications): notify on new mail and refresh unread badge"
```

---

## Final Verification

- [ ] **Step 1: Full Rust unit suite**

```bash
cargo test --workspace --lib --bins
```
Expected: PASS (am-storage gains 7 notifications_repo tests).

- [ ] **Step 2: Full frontend suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run
```
Expected: PASS, including the new test files. If `src/app/AppShell.test.tsx` reports a missing notification command/hook/store field in its `../ipc/queries`, `../ipc/bindings`, or `../app/store` mocks, add the needed stubs there and re-run. (Cross-suite regression only the full run catches.) Known independent flake: `src/shared/hooks/useDebouncedValue.test.ts` (timing) — not a 7b regression.

- [ ] **Step 3: Production build (typecheck)**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm run build
```
Expected: PASS — tsc + vite clean (catches unused imports / incomplete TS literals that vitest misses).

- [ ] **Step 4: If Step 2 required AppShell.test changes — commit**

```bash
git add src/app/AppShell.test.tsx
git commit -m "test(notifications): add notification mocks to AppShell suite"
```
