# Message List Filter & Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zastąpić nieaktywną etykietę `Newest ▾` obok przycisku Compose interaktywną kontrolką „Filtruj i sortuj" dla widoku folderu (wątki): sortowanie po dacie rosnąco/malejąco, filtr po nadawcy, filtr tematu, „tylko z załącznikami" — z filtrowaniem po stronie backendu (cała skrzynka).

**Architecture:** Backend dostaje nowy typ `ThreadListFilters` (`am-core`) i funkcję `threads_repo::list_for_folder_filtered` budującą dynamiczny SQL (sortowanie z whitelisty, LIKE z parametrów bind + escaping). Komenda `list_threads` zyskuje parametr `filters`; bindingi regenerowane przez `specta`. Front: kierunek sortowania w general settings (trwały, jak `threadOrder`), filtry tekstowe/załączniki jako stan sesyjny w `useUiStore` resetowany przy zmianie folderu; dedykowany komponent `FilterSortMenu`; `useThreads(folderId, filters)` z filtrami w kluczu react-query i debounce 200 ms na polach tekstowych.

**Tech Stack:** Rust (rusqlite + specta + serde), Tauri 2 + tauri-specta, React 19/TS, @tanstack/react-query v5, zustand, vitest + @testing-library/react + happy-dom, lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-29-message-list-filter-sort-design.md`

## Global Constraints

- Identyfikatory w kodzie po angielsku; ZERO komentarzy w kodzie źródłowym (notatki trwałe → `docs/`).
- Node 24: `$HOME/.nvm/versions/node/v24.14.0/bin` musi być na PATH dla `npm` (aktywny systemowy Node to 18). Prefiks w poleceniach: `PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npm …`.
- `npm run gen:bindings` po KAŻDEJ zmianie komendy/typu specta (regeneruje `src/ipc/bindings.ts`).
- Rust: `cargo test -p <crate>` per crate; pełne `cargo test` przed scaleniem.
- Frontend: `npx vitest run <plik>` (lub `npm test`).
- Conventional Commits 1.0.0; bez dopisywania siebie jako co-autora; push tylko na wyraźną prośbę.
- Nigdy `git add .` — stage wyłącznie jawnie wymienione ścieżki (w repo jest gitignored sekret OAuth — nie wolno go zacommitować).
- Wartości tekstowe filtrów ZAWSZE jako parametry bind; sortowanie z whitelisty (literał ASC/DESC). Brak konkatenacji danych użytkownika do SQL.

---

## Task 1: Backend — typ filtrów, repo z dynamicznym SQL, komenda, bindingi

**Files:**
- Modify: `crates/am-core/src/thread.rs` (dodać `ThreadSortDir`, `ThreadListFilters`)
- Modify: `crates/am-storage/src/threads_repo.rs:56-105` (`list_for_folder` → wrapper; nowy `list_for_folder_filtered`; helper `like_contains`; testy)
- Modify: `crates/am-app/src/commands.rs:7-19` (import) i `:621-630` (`list_threads` + parametr `filters`)
- Regenerate: `src/ipc/bindings.ts`

**Interfaces:**
- Produces (Rust): `am_core::thread::ThreadSortDir` (`Asc`/`Desc`, serde `snake_case`, `Default` = `Desc`); `am_core::thread::ThreadListFilters { sort_dir: ThreadSortDir, sender: Option<String>, subject: Option<String>, attachments_only: bool }` (`Default`); `threads_repo::list_for_folder_filtered(db, folder_id, &ThreadListFilters, limit, offset, now) -> Result<Vec<ThreadSummary>, StorageError>`.
- Produces (TS, generated): `ThreadSortDir = "asc" | "desc"`; `ThreadListFilters = { sort_dir: ThreadSortDir; sender: string | null; subject: string | null; attachments_only: boolean }`; `commands.listThreads(folderId, filters, limit, offset)`.

- [ ] **Step 1: Dodać typy `ThreadSortDir` i `ThreadListFilters` w `am-core`**

W `crates/am-core/src/thread.rs`, pod istniejącą strukturą `ThreadSummary`, dodać:

```rust
#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThreadSortDir {
    Asc,
    #[default]
    Desc,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq, Eq, Default)]
pub struct ThreadListFilters {
    pub sort_dir: ThreadSortDir,
    pub sender: Option<String>,
    pub subject: Option<String>,
    pub attachments_only: bool,
}
```

- [ ] **Step 2: Napisać failing testy repo**

W `crates/am-storage/src/threads_repo.rs`, w module `tests` (po `make_header`, korzystając z istniejących `setup`, `create`, `insert_headers`), dodać pomocnik i testy:

```rust
fn make_header_full(
    uid: i64,
    date: i64,
    message_id: &str,
    from_address: &str,
    subject: &str,
    has_attachments: bool,
) -> NewMessageHeader {
    NewMessageHeader {
        uid,
        message_id_hdr: Some(message_id.to_string()),
        in_reply_to: None,
        references_hdr: None,
        from_address: from_address.into(),
        from_name: None,
        subject: subject.into(),
        date,
        seen: true,
        flagged: false,
        answered: false,
        has_attachments,
        size: 512,
        snippet: String::new(),
    }
}

#[test]
fn list_for_folder_filtered_sorts_filters_sender_subject_attachments() {
    let db = Database::open_in_memory().unwrap();
    let (account_id, folder_id) = setup(&db);

    let ta = create(&db, account_id, "Invoice March", 1000).unwrap();
    insert_headers(&db, folder_id, &[make_header_full(1, 1000, "<a@x>", "alice@example.com", "Invoice March", true)]).unwrap();
    let tb = create(&db, account_id, "Lunch plans", 2000).unwrap();
    insert_headers(&db, folder_id, &[make_header_full(2, 2000, "<b@x>", "bob@example.com", "Lunch plans", false)]).unwrap();
    {
        let conn = db.conn();
        conn.execute("UPDATE messages SET thread_id = ?1 WHERE message_id_hdr = '<a@x>'", params![ta]).unwrap();
        conn.execute("UPDATE messages SET thread_id = ?1 WHERE message_id_hdr = '<b@x>'", params![tb]).unwrap();
    }
    let ids = |v: &[ThreadSummary]| v.iter().map(|t| t.thread_id).collect::<Vec<_>>();

    let def = list_for_folder_filtered(&db, folder_id, &ThreadListFilters::default(), 10, 0, i64::MAX).unwrap();
    assert_eq!(ids(&def), vec![tb, ta]);

    let asc = list_for_folder_filtered(&db, folder_id, &ThreadListFilters { sort_dir: ThreadSortDir::Asc, ..Default::default() }, 10, 0, i64::MAX).unwrap();
    assert_eq!(ids(&asc), vec![ta, tb]);

    let sender = list_for_folder_filtered(&db, folder_id, &ThreadListFilters { sender: Some("alice".into()), ..Default::default() }, 10, 0, i64::MAX).unwrap();
    assert_eq!(ids(&sender), vec![ta]);

    let subject = list_for_folder_filtered(&db, folder_id, &ThreadListFilters { subject: Some("Lunch".into()), ..Default::default() }, 10, 0, i64::MAX).unwrap();
    assert_eq!(ids(&subject), vec![tb]);

    let att = list_for_folder_filtered(&db, folder_id, &ThreadListFilters { attachments_only: true, ..Default::default() }, 10, 0, i64::MAX).unwrap();
    assert_eq!(ids(&att), vec![ta]);
}

#[test]
fn list_for_folder_filtered_escapes_like_wildcards() {
    let db = Database::open_in_memory().unwrap();
    let (account_id, folder_id) = setup(&db);

    let t1 = create(&db, account_id, "50% off sale", 1000).unwrap();
    insert_headers(&db, folder_id, &[make_header_full(1, 1000, "<p@x>", "promo@example.com", "50% off sale", false)]).unwrap();
    let t2 = create(&db, account_id, "500 dollars off", 2000).unwrap();
    insert_headers(&db, folder_id, &[make_header_full(2, 2000, "<q@x>", "promo@example.com", "500 dollars off", false)]).unwrap();
    {
        let conn = db.conn();
        conn.execute("UPDATE messages SET thread_id = ?1 WHERE message_id_hdr = '<p@x>'", params![t1]).unwrap();
        conn.execute("UPDATE messages SET thread_id = ?1 WHERE message_id_hdr = '<q@x>'", params![t2]).unwrap();
    }

    let res = list_for_folder_filtered(&db, folder_id, &ThreadListFilters { subject: Some("50%".into()), ..Default::default() }, 10, 0, i64::MAX).unwrap();
    assert_eq!(res.iter().map(|t| t.thread_id).collect::<Vec<_>>(), vec![t1]);
}
```

Dodać import na górze modułu `tests` (obok istniejących): `use am_core::thread::{ThreadListFilters, ThreadSortDir};`. (Jeśli `make_header_full` zgłosi „nieużywany" przy pierwszym uruchomieniu — zignorować do Step 4.)

- [ ] **Step 3: Uruchomić testy — mają NIE skompilować/failować**

Run: `cargo test -p am-storage threads_repo::tests::list_for_folder_filtered`
Expected: błąd kompilacji „cannot find function `list_for_folder_filtered`" / „cannot find type `ThreadListFilters`".

- [ ] **Step 4: Zaimplementować `like_contains`, `list_for_folder_filtered` i wrapper `list_for_folder`**

W `crates/am-storage/src/threads_repo.rs` zmienić import na:

```rust
use am_core::thread::{ThreadListFilters, ThreadSortDir, ThreadSummary};
```

Zastąpić obecną funkcję `list_for_folder` (linie 56-105) poniższym blokiem (helper + wrapper + nowa funkcja):

```rust
fn like_contains(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub fn list_for_folder(db: &Database, folder_id: i64, limit: i64, offset: i64, now: i64) -> Result<Vec<ThreadSummary>, StorageError> {
    list_for_folder_filtered(db, folder_id, &ThreadListFilters::default(), limit, offset, now)
}

pub fn list_for_folder_filtered(
    db: &Database,
    folder_id: i64,
    filters: &ThreadListFilters,
    limit: i64,
    offset: i64,
    now: i64,
) -> Result<Vec<ThreadSummary>, StorageError> {
    let conn = db.conn();

    let mut bind: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    bind.push(Box::new(folder_id));
    bind.push(Box::new(now));

    let sender_clause = match filters.sender.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => {
            let pat = like_contains(s);
            bind.push(Box::new(pat.clone()));
            bind.push(Box::new(pat));
            "AND (from_address LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\')"
        }
        None => "",
    };

    let subject_clause = match filters.subject.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => {
            bind.push(Box::new(like_contains(s)));
            "AND t.subject_root LIKE ? ESCAPE '\\'"
        }
        None => "",
    };

    let having_clause = if filters.attachments_only {
        "HAVING MAX(m.has_attachments) = 1"
    } else {
        ""
    };

    let dir = match filters.sort_dir {
        ThreadSortDir::Asc => "ASC",
        ThreadSortDir::Desc => "DESC",
    };

    bind.push(Box::new(limit));
    bind.push(Box::new(offset));

    let sql = format!(
        "SELECT t.id, t.account_id, t.subject_root, t.last_date, t.message_count,
                (SELECT count(*) FROM messages WHERE thread_id = t.id AND draft = 0 AND deleted = 0 AND seen = 0
                  AND id IN (SELECT MIN(id) FROM messages WHERE thread_id = t.id AND draft = 0
                             GROUP BY COALESCE(message_id_hdr, 'id:' || id))),
                MAX(m.has_attachments), MAX(m.flagged),
                group_concat(DISTINCT COALESCE(m.from_name, m.from_address)),
                (SELECT snippet FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1),
                (SELECT subject FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1),
                (SELECT m2.answered FROM messages m2
                  WHERE m2.thread_id = t.id AND m2.draft = 0 AND m2.deleted = 0
                    AND m2.from_address <> (SELECT a.email FROM accounts a WHERE a.id = t.account_id)
                  ORDER BY m2.date DESC LIMIT 1)
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
         WHERE t.id IN (SELECT DISTINCT thread_id FROM messages
                        WHERE folder_id = ? AND thread_id IS NOT NULL AND draft = 0 AND deleted = 0
                          AND (snooze_wake_at IS NULL OR snooze_wake_at <= ?)
                          {sender_clause})
           {subject_clause}
           AND m.draft = 0
         GROUP BY t.id
         {having_clause}
         ORDER BY t.last_date {dir}
         LIMIT ? OFFSET ?"
    );

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(param_refs), |row| {
        let participants_csv: Option<String> = row.get(8)?;
        let latest_subject: Option<String> = row.get(10)?;
        let subject_root: String = row.get(2)?;
        Ok(ThreadSummary {
            thread_id: row.get(0)?,
            account_id: row.get(1)?,
            subject: latest_subject.filter(|s| !s.is_empty()).unwrap_or(subject_root),
            last_date: row.get(3)?,
            message_count: row.get(4)?,
            unread_count: row.get(5)?,
            participants: participants_csv
                .map(|s| s.split(',').map(|p| p.to_string()).collect())
                .unwrap_or_default(),
            snippet: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
            has_attachments: row.get::<_, i64>(6)? != 0,
            flagged: row.get::<_, i64>(7)? != 0,
            answered: row.get::<_, Option<i64>>(11)?.unwrap_or(0) != 0,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

- [ ] **Step 5: Uruchomić testy repo — mają przejść**

Run: `cargo test -p am-storage threads_repo::tests::list_for_folder_filtered`
Expected: 2 testy PASS.

Run też pełen crate (regresja istniejących wołających przez wrapper): `cargo test -p am-storage`
Expected: wszystkie PASS.

- [ ] **Step 6: Rozszerzyć komendę `list_threads` o parametr `filters`**

W `crates/am-app/src/commands.rs` w bloku `use am_core::{ … }` dodać do listy `thread::ThreadSummary,` sąsiednią pozycję `thread::ThreadListFilters,`.

Zamienić funkcję `list_threads` (linie 621-630) na:

```rust
#[tauri::command]
#[specta::specta]
pub fn list_threads(
    state: tauri::State<'_, AppState>,
    folder_id: i64,
    filters: ThreadListFilters,
    limit: i64,
    offset: i64,
) -> Result<Vec<ThreadSummary>, String> {
    am_storage::threads_repo::list_for_folder_filtered(&state.db, folder_id, &filters, limit, offset, am_sync::service::now_secs()).map_err(|e| e.to_string())
}
```

- [ ] **Step 7: Sprawdzić kompilację aplikacji**

Run: `cargo check -p am-app`
Expected: kompiluje się bez błędów.

- [ ] **Step 8: Zregenerować bindingi specta**

Run: `PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" npm run gen:bindings`
Expected: zaktualizowany `src/ipc/bindings.ts`.

Weryfikacja: `rg -n "ThreadListFilters|ThreadSortDir|listThreads:" src/ipc/bindings.ts`
Expected: typ `ThreadListFilters`, `ThreadSortDir = \"asc\" | \"desc\"` oraz `listThreads: (folderId: number, filters: ThreadListFilters, limit: number, offset: number) => …`.

- [ ] **Step 9: Commit**

```bash
git add crates/am-core/src/thread.rs crates/am-storage/src/threads_repo.rs crates/am-app/src/commands.rs src/ipc/bindings.ts
git commit -m "feat(threads): backend filtering and sorting for thread list"
```

---

## Task 2: General settings — trwały `listSortDir`

**Files:**
- Modify: `src/shared/general/general.ts`
- Test: `src/shared/general/general.test.ts`

**Interfaces:**
- Consumes: nic.
- Produces: `ListSortDir = "asc" | "desc"`; `GeneralFields.listSortDir: ListSortDir`; `GENERAL_KEYS.listSortDir = "general.listSortDir"`; `DEFAULT_GENERAL.listSortDir = "desc"`; `parseGeneralSettings` obsługuje klucz `general.listSortDir`.

- [ ] **Step 1: Napisać failing test**

W `src/shared/general/general.test.ts` dodać:

```ts
it("whitelists listSortDir and rejects junk", () => {
  expect(parseGeneralSettings([[GENERAL_KEYS.listSortDir, "asc"]]).listSortDir).toBe("asc");
  expect(parseGeneralSettings([[GENERAL_KEYS.listSortDir, "desc"]]).listSortDir).toBe("desc");
  expect(parseGeneralSettings([[GENERAL_KEYS.listSortDir, "nope"]]).listSortDir).toBeUndefined();
});

it("defaults listSortDir to desc", () => {
  expect(DEFAULT_GENERAL.listSortDir).toBe("desc");
});
```

Upewnić się, że w imporcie testu jest `DEFAULT_GENERAL` (dodać, jeśli brak).

- [ ] **Step 2: Uruchomić test — ma failować**

Run: `npx vitest run src/shared/general/general.test.ts`
Expected: FAIL (`listSortDir` nie istnieje na `DEFAULT_GENERAL` / nieparsowany).

- [ ] **Step 3: Zaimplementować `listSortDir` w general.ts**

W `src/shared/general/general.ts`:

Po `export type ThreadOrder = …` dodać:

```ts
export type ListSortDir = "asc" | "desc";
```

W `GeneralFields` dodać pole: `listSortDir: ListSortDir;`

W `GENERAL_KEYS` dodać: `listSortDir: "general.listSortDir",`

W `DEFAULT_GENERAL` dodać: `listSortDir: "desc",`

Dodać guard (obok `isThreadOrder`):

```ts
function isListSortDir(v: string): v is ListSortDir {
  return v === "asc" || v === "desc";
}
```

W `parseGeneralSettings`, w `switch`, dodać `case`:

```ts
case GENERAL_KEYS.listSortDir:
  if (isListSortDir(value)) out.listSortDir = value;
  break;
```

- [ ] **Step 4: Uruchomić test — ma przejść**

Run: `npx vitest run src/shared/general/general.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/general/general.ts src/shared/general/general.test.ts
git commit -m "feat(settings): persist list sort direction in general settings"
```

---

## Task 3: Store + GeneralProvider — stan filtrów i sortowania

**Files:**
- Modify: `src/app/store.ts`
- Modify: `src/shared/general/GeneralProvider.tsx`
- Test: `src/app/store.test.ts`
- Test: `src/shared/general/GeneralProvider.test.tsx`

**Interfaces:**
- Consumes: `ListSortDir`, `GENERAL_KEYS` (Task 2); `commands.setSetting` (istniejący).
- Produces (store): pola `listSortDir`, `listFilterSender`, `listFilterSubject`, `listFilterAttachmentsOnly`; akcje `setListSortDir`, `setListFilterSender`, `setListFilterSubject`, `setListFilterAttachmentsOnly`, `clearListFilters` (zeruje TYLKO trzy filtry). Hydracja `listSortDir` przez istniejące `hydrateGeneral`.
- Produces (provider): `useGeneral().listSortDir` i `useGeneral().setListSortDir` (persist do `general.listSortDir`).

- [ ] **Step 1: Napisać failing testy store**

W `src/app/store.test.ts` dodać:

```ts
it("sets and clears list filters without touching sort direction", () => {
  const s = useUiStore.getState();
  s.setListSortDir("asc");
  s.setListFilterSender("alice");
  s.setListFilterSubject("invoice");
  s.setListFilterAttachmentsOnly(true);
  let st = useUiStore.getState();
  expect(st.listSortDir).toBe("asc");
  expect(st.listFilterSender).toBe("alice");
  expect(st.listFilterSubject).toBe("invoice");
  expect(st.listFilterAttachmentsOnly).toBe(true);

  st.clearListFilters();
  st = useUiStore.getState();
  expect(st.listFilterSender).toBe("");
  expect(st.listFilterSubject).toBe("");
  expect(st.listFilterAttachmentsOnly).toBe(false);
  expect(st.listSortDir).toBe("asc");
});

it("hydrateGeneral applies listSortDir", () => {
  useUiStore.getState().hydrateGeneral({ listSortDir: "asc" });
  expect(useUiStore.getState().listSortDir).toBe("asc");
});
```

- [ ] **Step 2: Uruchomić — ma failować**

Run: `npx vitest run src/app/store.test.ts`
Expected: FAIL (brak `setListSortDir`/`clearListFilters`/pól).

- [ ] **Step 3: Dodać pola, sygnatury i akcje w store.ts**

W `src/app/store.ts`:

W bloku importu z `../shared/general/general` dodać `type ListSortDir` do listy:

```ts
import {
  DEFAULT_GENERAL,
  type GeneralFields,
  type TimeFormat,
  type MarkReadMode,
  type ThreadOrder,
  type ListSortDir,
} from "../shared/general/general";
```

Pod `export type { ThreadOrder };` dodać `export type { ListSortDir };`.

W definicji typu stanu (obok `threadOrder: ThreadOrder;`) dodać pola:

```ts
  listSortDir: ListSortDir;
  listFilterSender: string;
  listFilterSubject: string;
  listFilterAttachmentsOnly: boolean;
```

W sekcji sygnatur akcji (obok `setThreadOrder: …`) dodać:

```ts
  setListSortDir: (value: ListSortDir) => void;
  setListFilterSender: (value: string) => void;
  setListFilterSubject: (value: string) => void;
  setListFilterAttachmentsOnly: (value: boolean) => void;
  clearListFilters: () => void;
```

W bloku wartości początkowych (obok `threadOrder: DEFAULT_GENERAL.threadOrder,`) dodać:

```ts
  listSortDir: DEFAULT_GENERAL.listSortDir,
  listFilterSender: "",
  listFilterSubject: "",
  listFilterAttachmentsOnly: false,
```

W bloku implementacji akcji (obok `setThreadOrder: (threadOrder) => set({ threadOrder }),`) dodać:

```ts
  setListSortDir: (listSortDir) => set({ listSortDir }),
  setListFilterSender: (listFilterSender) => set({ listFilterSender }),
  setListFilterSubject: (listFilterSubject) => set({ listFilterSubject }),
  setListFilterAttachmentsOnly: (listFilterAttachmentsOnly) => set({ listFilterAttachmentsOnly }),
  clearListFilters: () =>
    set({ listFilterSender: "", listFilterSubject: "", listFilterAttachmentsOnly: false }),
```

(`hydrateGeneral` to `set({ ...partial, generalHydrated: true })` — `listSortDir` ustawi się automatycznie z `partial`.)

- [ ] **Step 4: Uruchomić testy store — mają przejść**

Run: `npx vitest run src/app/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Napisać failing test providera**

W `src/shared/general/GeneralProvider.test.tsx` dodać test, że ustawienie sortowania persystuje (wzór istniejących asercji `setSetting`):

```ts
it("setListSortDir persists general.listSortDir", async () => {
  const { result } = renderHook(() => useGeneral(), { wrapper });
  act(() => result.current.setListSortDir("asc"));
  expect(setSetting).toHaveBeenCalledWith("general.listSortDir", "asc");
  expect(useUiStore.getState().listSortDir).toBe("asc");
});
```

(Użyć tych samych importów/utili `renderHook`, `act`, `wrapper`, `setSetting`, `useGeneral`, `useUiStore` co istniejące testy w tym pliku.)

- [ ] **Step 6: Uruchomić — ma failować**

Run: `npx vitest run src/shared/general/GeneralProvider.test.tsx`
Expected: FAIL (`setListSortDir` nie istnieje na kontekście).

- [ ] **Step 7: Dodać `listSortDir`/`setListSortDir` do GeneralProvider**

W `src/shared/general/GeneralProvider.tsx`:

W imporcie z `./general` dodać `type ListSortDir`:

```ts
import { GENERAL_KEYS, parseGeneralSettings, type TimeFormat, type MarkReadMode, type ThreadOrder, type ListSortDir } from "./general";
```

W typie `GeneralContextValue` dodać:

```ts
  listSortDir: ListSortDir;
  setListSortDir: (value: ListSortDir) => void;
```

W komponencie dodać odczyt ze store (obok `threadOrder`):

```ts
  const listSortDir = useUiStore((s) => s.listSortDir);
  const storeSetListSortDir = useUiStore((s) => s.setListSortDir);
```

W obiekcie `value` dodać pole + setter (obok `setThreadOrder`):

```ts
      listSortDir,
      setListSortDir: (v) => {
        storeSetListSortDir(v);
        persist(GENERAL_KEYS.listSortDir, v);
      },
```

W tablicy zależności `useMemo` dodać: `listSortDir,` oraz `storeSetListSortDir,`.

- [ ] **Step 8: Uruchomić testy providera — mają przejść**

Run: `npx vitest run src/shared/general/GeneralProvider.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts src/shared/general/GeneralProvider.tsx src/shared/general/GeneralProvider.test.tsx
git commit -m "feat(store): list filter and sort state"
```

---

## Task 4: Komponent `FilterSortMenu` + style

**Files:**
- Create: `src/features/message-list/FilterSortMenu.tsx`
- Modify: `src/features/message-list/MessageListPane.css` (zastąpić `.message-list__sort`, dodać style kontrolki)
- Test: `src/features/message-list/FilterSortMenu.test.tsx`

**Interfaces:**
- Consumes: `useUiStore` (filtry + `clearListFilters`), `useGeneral` (`listSortDir`, `setListSortDir`).
- Produces: `<FilterSortMenu />` (bez propsów). Widoczność steruje rodzic (Task 5).

- [ ] **Step 1: Napisać failing test komponentu**

`src/features/message-list/FilterSortMenu.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterSortMenu } from "./FilterSortMenu";

const setListFilterSender = vi.fn();
const setListFilterSubject = vi.fn();
const setListFilterAttachmentsOnly = vi.fn();
const clearListFilters = vi.fn();
const setListSortDir = vi.fn();

let state = {
  listFilterSender: "",
  listFilterSubject: "",
  listFilterAttachmentsOnly: false,
  setListFilterSender,
  setListFilterSubject,
  setListFilterAttachmentsOnly,
  clearListFilters,
};

vi.mock("../../app/store", () => ({
  useUiStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

vi.mock("../../shared/general/GeneralProvider", () => ({
  useGeneral: () => ({ listSortDir: "desc", setListSortDir }),
}));

describe("FilterSortMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      listFilterSender: "",
      listFilterSubject: "",
      listFilterAttachmentsOnly: false,
      setListFilterSender,
      setListFilterSubject,
      setListFilterAttachmentsOnly,
      clearListFilters,
    };
  });

  it("opens the panel and edits filters and sort", () => {
    render(<FilterSortMenu />);
    fireEvent.click(screen.getByRole("button", { name: /filter and sort/i }));

    fireEvent.click(screen.getByLabelText(/oldest first/i));
    expect(setListSortDir).toHaveBeenCalledWith("asc");

    fireEvent.change(screen.getByLabelText(/from contains/i), { target: { value: "alice" } });
    expect(setListFilterSender).toHaveBeenCalledWith("alice");

    fireEvent.change(screen.getByLabelText(/subject contains/i), { target: { value: "invoice" } });
    expect(setListFilterSubject).toHaveBeenCalledWith("invoice");

    fireEvent.click(screen.getByLabelText(/only with attachments/i));
    expect(setListFilterAttachmentsOnly).toHaveBeenCalledWith(true);
  });

  it("disables Clear when no filters are set", () => {
    render(<FilterSortMenu />);
    fireEvent.click(screen.getByRole("button", { name: /filter and sort/i }));
    expect(screen.getByRole("button", { name: /clear/i })).toBeDisabled();
  });

  it("shows the active indicator and enables Clear when a filter is set", () => {
    state.listFilterSender = "alice";
    render(<FilterSortMenu />);
    expect(screen.getByRole("button", { name: /filter and sort/i })).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByRole("button", { name: /filter and sort/i }));
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(clearListFilters).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Uruchomić — ma failować**

Run: `npx vitest run src/features/message-list/FilterSortMenu.test.tsx`
Expected: FAIL (`./FilterSortMenu` nie istnieje).

- [ ] **Step 3: Zaimplementować komponent**

`src/features/message-list/FilterSortMenu.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useUiStore } from "../../app/store";
import { useGeneral } from "../../shared/general/GeneralProvider";

export function FilterSortMenu() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { listSortDir, setListSortDir } = useGeneral();
  const sender = useUiStore((s) => s.listFilterSender);
  const subject = useUiStore((s) => s.listFilterSubject);
  const attachmentsOnly = useUiStore((s) => s.listFilterAttachmentsOnly);
  const setSender = useUiStore((s) => s.setListFilterSender);
  const setSubject = useUiStore((s) => s.setListFilterSubject);
  const setAttachmentsOnly = useUiStore((s) => s.setListFilterAttachmentsOnly);
  const clearListFilters = useUiStore((s) => s.clearListFilters);

  const filtersActive = sender !== "" || subject !== "" || attachmentsOnly;
  const indicatorActive = filtersActive || listSortDir !== "desc";

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="list-filter" ref={containerRef}>
      <button
        type="button"
        className="list-filter__trigger"
        aria-label="Filter and sort"
        aria-haspopup="true"
        aria-expanded={open}
        data-active={indicatorActive}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal size={15} />
        {indicatorActive && <span className="list-filter__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="list-filter__panel" role="dialog" aria-label="Filter and sort">
          <fieldset className="list-filter__sort">
            <legend>Sort</legend>
            <label>
              <input
                type="radio"
                name="list-sort"
                checked={listSortDir === "desc"}
                onChange={() => setListSortDir("desc")}
              />
              Newest first
            </label>
            <label>
              <input
                type="radio"
                name="list-sort"
                checked={listSortDir === "asc"}
                onChange={() => setListSortDir("asc")}
              />
              Oldest first
            </label>
          </fieldset>

          <div className="list-filter__field">
            <label htmlFor="list-filter-sender">From contains</label>
            <input
              id="list-filter-sender"
              type="text"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
          </div>

          <div className="list-filter__field">
            <label htmlFor="list-filter-subject">Subject contains</label>
            <input
              id="list-filter-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <label className="list-filter__check">
            <input
              type="checkbox"
              checked={attachmentsOnly}
              onChange={(e) => setAttachmentsOnly(e.target.checked)}
            />
            Only with attachments
          </label>

          <div className="list-filter__footer">
            <button
              type="button"
              className="list-filter__clear"
              disabled={!filtersActive}
              onClick={() => clearListFilters()}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Uruchomić testy komponentu — mają przejść**

Run: `npx vitest run src/features/message-list/FilterSortMenu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Dodać style i usunąć martwy `.message-list__sort`**

W `src/features/message-list/MessageListPane.css` usunąć regułę `.message-list__sort` (linie ~202-209) i dodać:

```css
.list-filter {
  position: relative;
  display: flex;
  align-items: center;
}

.list-filter__trigger {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.list-filter__trigger:hover {
  background: var(--surface-hover, rgba(127, 127, 127, 0.12));
  color: var(--text);
}

.list-filter__trigger[data-active="true"] {
  color: var(--accent);
}

.list-filter__dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.list-filter__panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 260px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 12px 32px -12px rgba(0, 0, 0, 0.45);
}

.list-filter__sort {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
}

.list-filter__sort legend,
.list-filter__field label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.list-filter__sort label,
.list-filter__check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  text-transform: none;
  letter-spacing: 0;
}

.list-filter__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.list-filter__field input[type="text"] {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-2, var(--surface));
  color: var(--text);
  font-size: 13px;
}

.list-filter__footer {
  display: flex;
  justify-content: flex-end;
}

.list-filter__clear {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.list-filter__clear:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/features/message-list/FilterSortMenu.tsx src/features/message-list/FilterSortMenu.test.tsx src/features/message-list/MessageListPane.css
git commit -m "feat(message-list): filter and sort control"
```

---

## Task 5: Integracja — `useThreads(filters)` + `MessageListPane`

**Files:**
- Modify: `src/ipc/queries.ts:38-44` (`useThreads`)
- Modify: `src/features/message-list/MessageListPane.tsx` (import, budowa filtrów, reset, render kontrolki, pusty stan)
- Modify: `src/features/message-list/MessageListPane.test.tsx` (uzupełnić mock store o nowe pola; dodać testy)
- Test (queries): `src/ipc/queries.pinned.test.tsx`

**Interfaces:**
- Consumes: `commands.listThreads(folderId, filters, limit, offset)` i typ `ThreadListFilters` (Task 1); store filtry + `clearListFilters` (Task 3); `<FilterSortMenu />` (Task 4).
- Produces: `useThreads(folderId: number | null, filters: ThreadListFilters)`.

- [ ] **Step 1: Napisać failing test dla `useThreads`**

W `src/ipc/queries.pinned.test.tsx` dodać test, że `useThreads` woła `commands.listThreads` z filtrami i poprawnymi argumentami. Wzorując się na istniejącym mocku `commands` w tym pliku, dodać:

```ts
it("passes filters to listThreads", async () => {
  const filters = { sort_dir: "asc", sender: "alice", subject: null, attachments_only: true } as const;
  const { result } = renderHook(() => useThreads(7, filters), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(listThreadsSpy).toHaveBeenCalledWith(7, filters, 100, 0);
});
```

(Użyć istniejących w pliku narzędzi: `renderHook`, `waitFor`, `wrapper`, oraz spy na `commands.listThreads` — jeśli go nie ma, dodać `const listThreadsSpy = vi.spyOn(commands, "listThreads").mockResolvedValue({ status: "ok", data: [] });` w `beforeEach`/teście, zgodnie z konwencją pliku. Zaimportować `useThreads` z `./queries`.)

- [ ] **Step 2: Uruchomić — ma failować**

Run: `npx vitest run src/ipc/queries.pinned.test.tsx`
Expected: FAIL (`useThreads` ma starą sygnaturę bez `filters`).

- [ ] **Step 3: Rozszerzyć `useThreads` o `filters`**

W `src/ipc/queries.ts`:

Dodać import typu (jeśli plik nie importuje jeszcze z bindings — dopisać do istniejącego importu):

```ts
import type { ThreadListFilters } from "./bindings";
```

Zamienić `useThreads` (linie 38-44) na:

```ts
export function useThreads(folderId: number | null, filters: ThreadListFilters) {
  return useQuery({
    queryKey: ["threads", folderId, filters],
    queryFn: () => commands.listThreads(folderId!, filters, 100, 0).then(unwrap),
    enabled: folderId != null,
  });
}
```

- [ ] **Step 4: Uruchomić — ma przejść**

Run: `npx vitest run src/ipc/queries.pinned.test.tsx`
Expected: PASS.

- [ ] **Step 5: Zintegrować z `MessageListPane`**

W `src/features/message-list/MessageListPane.tsx`:

Dodać importy:

```ts
import type { ThreadListFilters } from "../../ipc/bindings";
import { FilterSortMenu } from "./FilterSortMenu";
```

Po istniejących odczytach ze store (okolice linii 208-211) dodać:

```ts
  const listSortDir = useUiStore((s) => s.listSortDir);
  const listFilterSender = useUiStore((s) => s.listFilterSender);
  const listFilterSubject = useUiStore((s) => s.listFilterSubject);
  const listFilterAttachmentsOnly = useUiStore((s) => s.listFilterAttachmentsOnly);
  const clearListFilters = useUiStore((s) => s.clearListFilters);
```

Po istniejącym `const debouncedQuery = useDebouncedValue(searchQuery, 200);` dodać debounce filtrów i budowę obiektu filtrów:

```ts
  const debouncedSender = useDebouncedValue(listFilterSender, 200);
  const debouncedSubject = useDebouncedValue(listFilterSubject, 200);

  const threadFilters = useMemo<ThreadListFilters>(
    () => ({
      sort_dir: listSortDir,
      sender: debouncedSender.trim() === "" ? null : debouncedSender,
      subject: debouncedSubject.trim() === "" ? null : debouncedSubject,
      attachments_only: listFilterAttachmentsOnly,
    }),
    [listSortDir, debouncedSender, debouncedSubject, listFilterAttachmentsOnly]
  );
```

Zmienić wywołanie hooka (linia 220):

```ts
  const { data: threads, isLoading: threadsLoading } = useThreads(selectedFolderId, threadFilters);
```

Dodać efekt resetujący filtry przy zmianie folderu (po obliczeniu `isFlatMode`/`isDraftsMode`, obok istniejących `useEffect`):

```ts
  useEffect(() => {
    clearListFilters();
  }, [selectedFolderId, clearListFilters]);
```

W nagłówku zastąpić martwy `<span className="message-list__sort" …>Newest …</span>` warunkowym renderem kontrolki:

```tsx
        {!isFlatMode && !isDraftsMode && <FilterSortMenu />}
```

Zmienić pusty stan (linie ~371-373) tak, by przy aktywnych filtrach pokazać dedykowany komunikat:

```tsx
      {hasSelection && !isLoading && rawItems.length === 0 && (
        !isFlatMode && !isDraftsMode && (listFilterSender !== "" || listFilterSubject !== "" || listFilterAttachmentsOnly) ? (
          <div className="message-list__empty">
            No messages match your filters
            <button
              type="button"
              className="list-filter__clear"
              onClick={() => clearListFilters()}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="message-list__empty">No messages</div>
        )
      )}
```

- [ ] **Step 6: Uzupełnić mock store w teście MessageListPane**

W `src/features/message-list/MessageListPane.test.tsx`, w obiekcie stanu używanym do mocka `useUiStore`, dodać brakujące pola i akcje (inaczej selektory zwrócą `undefined` i komponent się wywali — jak w gotcha smart-folders):

```ts
  listSortDir: "desc",
  listFilterSender: "",
  listFilterSubject: "",
  listFilterAttachmentsOnly: false,
  setListSortDir: vi.fn(),
  setListFilterSender: vi.fn(),
  setListFilterSubject: vi.fn(),
  setListFilterAttachmentsOnly: vi.fn(),
  clearListFilters: vi.fn(),
```

Jeśli `MessageListPane.test.tsx` nie renderuje w `GeneralProvider`, dodać mock providera (kontrolka jest dzieckiem panelu w trybie folderu):

```ts
vi.mock("../../shared/general/GeneralProvider", () => ({
  useGeneral: () => ({ listSortDir: "desc", setListSortDir: vi.fn() }),
}));
```

Dodać dwa testy:

```ts
it("shows the filter/sort control in folder mode", () => {
  // konfiguracja trybu folderu jak w istniejących testach (selectedFolderId ustawiony, brak search/label/smart)
  renderPane(/* helper z pliku, tryb folderu */);
  expect(screen.getByRole("button", { name: /filter and sort/i })).toBeInTheDocument();
});

it("hides the filter/sort control in search mode", () => {
  // tryb wyszukiwania jak w istniejących testach (searchActive = true)
  renderPane(/* helper z pliku, tryb search */);
  expect(screen.queryByRole("button", { name: /filter and sort/i })).toBeNull();
});
```

(Wykorzystać istniejący w pliku helper renderujący panel oraz wzorce ustawiania trybu — `searchActive`, `selectedSmartFolder`, `selectedLabelId` — z obecnych testów.)

- [ ] **Step 7: Uruchomić testy MessageListPane — mają przejść**

Run: `npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: PASS (łącznie z nowymi testami widoczności kontrolki).

- [ ] **Step 8: Pełny przebieg frontu i Rust**

Run: `npx vitest run`
Expected: brak NOWYCH regresji (uwzględnić listę pre-existing failing z pamięci projektu — nie naprawiać ich tutaj).

Run: `cargo test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ipc/queries.ts src/ipc/queries.pinned.test.tsx src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(message-list): wire filter and sort into thread list"
```

---

## Self-Review (wykonane przy pisaniu planu)

**Spec coverage:**
- Sortowanie po dacie asc/desc → Task 1 (SQL `ORDER BY … {dir}`), Task 4 (UI), Task 5 (przekazanie).
- Filtr po nadawcy → Task 1 (`sender` LIKE w podzapytaniu), Task 3/4/5.
- „Tylko z załącznikami" → Task 1 (`HAVING MAX(has_attachments)=1`), Task 4/5.
- Filtr po temacie (`subject_root`) → Task 1, Task 4/5.
- Backend / cała skrzynka → Task 1.
- Tylko widok folderu (ukryte w flat/drafts) → Task 5 (`!isFlatMode && !isDraftsMode`).
- Trwały `listSortDir`, sesyjne filtry + reset przy zmianie folderu → Task 2 (persist), Task 3 (`clearListFilters`), Task 5 (efekt resetu).
- Debounce 200 ms → Task 5. Kropka aktywności → Task 4. Pusty stan z filtrami → Task 5.
- Bezpieczeństwo LIKE (escaping + bind) + sort z whitelisty → Task 1 (`like_contains`, test escapowania, mapowanie enuma).
- Bindingi specta → Task 1 Step 8.

**Placeholder scan:** brak TBD/TODO; kod podany w krokach. Miejsca oznaczone „użyć istniejącego helpera/util z pliku" dotyczą wyłącznie współdzielenia gotowych narzędzi testowych (renderHook/wrapper/spy) i mocków specyficznych dla danego pliku testowego — nie są lukami w logice.

**Type consistency:** `ThreadListFilters` (snake_case: `sort_dir`, `sender`, `subject`, `attachments_only`) spójne między Rust (Task 1), bindings (Task 1 Step 8), budową obiektu (Task 5). `ListSortDir`/`ThreadSortDir` = `"asc" | "desc"` strukturalnie zgodne (store używa `ListSortDir`, komenda oczekuje `ThreadSortDir`). `clearListFilters` o tej samej sygnaturze w store (Task 3), komponencie (Task 4), panelu (Task 5).
