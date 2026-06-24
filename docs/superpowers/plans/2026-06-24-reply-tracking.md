# Reply tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pokazać na liście wątków, że odpowiedziałem na ostatnią przychodzącą wiadomość, oraz sprawić, by moja odpowiedź pojawiała się w widoku konwersacji od razu po wysłaniu.

**Architecture:** Hybryda — flaga IMAP `\Answered` per wiadomość (czytana przy sync, zapisywana na oryginale po wysłaniu reply przez istniejący mechanizm `set_flag`) plus natychmiastowe lokalne oznaczenie. Wskaźnik wątku = najnowsza przychodząca wiadomość ma `answered=1`. Natychmiastowa widoczność własnej odpowiedzi przez wymuszony `incremental_sync_folder` folderu „Wysłane" zaraz po wysyłce.

**Tech Stack:** Rust (workspace crates `am-core`, `am-storage`, `am-protocols`, `am-sync`, `am-app`), rusqlite + refinery (migracje), async-imap, tauri-specta (bindings TS), React + TypeScript + vitest, lucide-react (ikony).

## Global Constraints

- Wszystkie nazwy w kodzie po angielsku; bez komentarzy w kodzie (istotne notatki tylko do `docs/`).
- Każdy task kończy się commitem (Conventional Commits, bez współautora). Bez `git push` (chyba że użytkownik poprosi).
- Migracje refinery: następny wolny numer to **V16** (ostatnia istniejąca `V15__meeting_responses.sql`).
- `MessageFlag` to enum o `match` bez `_` w `flag_column`/`flag_label`/`imap_flag` — dodanie wariantu wymaga uzupełnienia wszystkich trzech, inaczej kompilacja nie przejdzie.
- Frontendowe testy z w pełni zmockowanym `useUiStore`/queries muszą zawierać nowe pola (`ThreadSummary.answered`, `MessageHeader.answered`), inaczej komponent się wywali (znana pułapka projektu).
- Baseline testów: 6 znanych, wcześniej padających testów vitest (ConversationView reply-button ×3, useDebouncedValue ×3) — nie naprawiać, nie liczyć jako regresję.
- Po zmianie typów eksportowanych przez specta regenerować `src/ipc/bindings.ts` przez `npm run gen:bindings`.

---

## File Structure

- `crates/am-storage/src/migrations/V16__answered.sql` — **CREATE**: kolumna `answered` w `messages`.
- `crates/am-core/src/message.rs` — **MODIFY**: `MessageHeader.answered`, `NewMessageHeader.answered`, `MessageFlag::Answered`.
- `crates/am-core/src/thread.rs` — **MODIFY**: `ThreadSummary.answered`.
- `crates/am-storage/src/messages_repo.rs` — **MODIFY**: `flag_column` arm; SELECT-y + `row_to_header`/`tuple_to_header` (12 kolumn); `insert_headers`; `set_flags_by_uid`; nowa `find_id_by_message_id_hdr`.
- `crates/am-storage/src/threads_repo.rs` — **MODIFY**: `list_for_folder` (podzapytanie `answered`) + mapowanie `ThreadSummary`.
- `crates/am-storage/src/db.rs` — **MODIFY (test)**: test migracji V16.
- `crates/am-protocols/src/imap.rs` — **MODIFY**: `FlagState.answered`, `FetchedHeader.answered`, `flag_state`, `map_header`.
- `crates/am-sync/src/service.rs` — **MODIFY**: `header_from_fetch`, wywołania `set_flags_by_uid`, `flag_label`/`imap_flag`, arm `"answered"` w drenażu `set_flag`.
- `crates/am-sync/src/send.rs` — **MODIFY**: `drain_outbox` — oznaczenie oryginału + natychmiastowy sync „Wysłane".
- `src/ipc/bindings.ts` — **REGEN**.
- `src/features/message-list/MessageListPane.tsx` — **MODIFY**: ikona „Odpowiedziano" na wątku.
- `src/features/reader/ConversationView.tsx` — **MODIFY**: ikona „Odpowiedziano" per wiadomość.

---

## Task 1: Backend data layer — flaga `answered` od DB do modeli

Wprowadza kolumnę `answered`, pola w modelach, wariant `MessageFlag::Answered` i całą obsługę odczytu/zapisu (storage + parsowanie IMAP). Dodanie pól łamie kompilację wszystkich konstruktorów — task domyka się, gdy `cargo build` i testy przechodzą.

**Files:**
- Create: `crates/am-storage/src/migrations/V16__answered.sql`
- Modify: `crates/am-core/src/message.rs`, `crates/am-core/src/thread.rs`
- Modify: `crates/am-storage/src/messages_repo.rs`, `crates/am-storage/src/threads_repo.rs`, `crates/am-storage/src/db.rs`
- Modify: `crates/am-protocols/src/imap.rs`
- Modify: `crates/am-sync/src/service.rs`

**Interfaces:**
- Produces: `MessageHeader.answered: bool`, `NewMessageHeader.answered: bool`, `ThreadSummary.answered: bool`, `MessageFlag::Answered`, `messages_repo::set_flags_by_uid(db, folder_id, uid, seen, flagged, answered)`, `messages_repo::find_id_by_message_id_hdr(db, account_id, &str) -> Result<Option<i64>, StorageError>`, `FlagState.answered`, `FetchedHeader.answered`.

- [ ] **Step 1: Test migracji (failing)**

W `crates/am-storage/src/db.rs`, w module `tests` (po `migration_v14_adds_is_html_column`, przed zamknięciem `}` modułu ~linia 188) dodaj:

```rust
    #[test]
    fn migration_v16_adds_answered_column() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('messages') WHERE name='answered'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
```

- [ ] **Step 2: Uruchom test — ma paść (brak kolumny)**

Run: `cargo test -p am-storage --lib migration_v16`
Expected: FAIL — `assert_eq!(count, 1)` dostaje 0.

- [ ] **Step 3: Utwórz migrację V16**

Plik `crates/am-storage/src/migrations/V16__answered.sql`:

```sql
ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Uruchom test migracji — ma przejść**

Run: `cargo test -p am-storage --lib migration_v16`
Expected: PASS.

- [ ] **Step 5: Dodaj pola do modeli am-core**

W `crates/am-core/src/message.rs`:
- w `enum MessageFlag` (po `Flagged,`) dodaj wariant `Answered,`
- w `struct MessageHeader` po `pub flagged: bool,` dodaj `pub answered: bool,`
- w `struct NewMessageHeader` po `pub flagged: bool,` dodaj `pub answered: bool,`
- w teście `message_header_roundtrips_through_json` w literale `MessageHeader { ... }` po `flagged: false,` dodaj `answered: false,`

W `crates/am-core/src/thread.rs`, w `struct ThreadSummary` po `pub flagged: bool,` dodaj `pub answered: bool,`

- [ ] **Step 6: Uzupełnij `MessageFlag` match-arms (storage + sync)**

W `crates/am-storage/src/messages_repo.rs` `fn flag_column` dodaj arm:
```rust
        MessageFlag::Answered => "answered",
```

W `crates/am-sync/src/service.rs`:
- `fn flag_label` dodaj arm `MessageFlag::Answered => "answered",`
- `fn imap_flag` dodaj arm `MessageFlag::Answered => "\\Answered",`
- w drenażu `set_flag` (match `parsed["flag"].as_str()`, ~linia 975) dodaj arm przed `_ =>`:
```rust
            Some("answered") => MessageFlag::Answered,
```

- [ ] **Step 7: Rozszerz odczyt/zapis w `messages_repo`**

W `crates/am-storage/src/messages_repo.rs`:

`fn row_to_header` — zmień typ zwracany i ciało na 12 kolumn (dodaj `answered` jako kolumnę 11):
```rust
fn row_to_header(row: &rusqlite::Row) -> rusqlite::Result<(i64, i64, i64, String, String, Option<String>, i64, i64, i64, i64, String, i64)> {
    Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, i64>(1)?,
        row.get::<_, i64>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, Option<String>>(5)?,
        row.get::<_, i64>(6)?,
        row.get::<_, i64>(7)?,
        row.get::<_, i64>(8)?,
        row.get::<_, i64>(9)?,
        row.get::<_, String>(10)?,
        row.get::<_, i64>(11)?,
    ))
}
```

`fn tuple_to_header` — rozszerz destrukturyzację i konstrukcję:
```rust
fn tuple_to_header(
    (id, account_id, folder_id, subject, from_address, from_name, date, seen, flagged, has_attachments, snippet, answered): (i64, i64, i64, String, String, Option<String>, i64, i64, i64, i64, String, i64),
) -> MessageHeader {
    MessageHeader {
        id,
        account_id,
        folder_id,
        subject,
        from_address,
        from_name,
        date,
        seen: seen != 0,
        flagged: flagged != 0,
        has_attachments: has_attachments != 0,
        snippet,
        answered: answered != 0,
    }
}
```

W trzech zapytaniach (`list_by_thread`, `list_by_folder`, `get_header`) dopisz `answered` na końcu listy kolumn SELECT, czyli zamień
`..., has_attachments, snippet` na `..., has_attachments, snippet, answered`.

`fn insert_headers` — w SQL dopisz kolumnę i parametr:
- lista kolumn: po `... has_attachments, size, snippet)` zmień na `... has_attachments, size, snippet, answered)`
- VALUES: dodaj `?16` po `?15`
- w `params![...]` po `h.snippet` dodaj `h.answered as i64`

`fn set_flags_by_uid` — zmień sygnaturę i SQL:
```rust
pub fn set_flags_by_uid(db: &Database, folder_id: i64, uid: i64, seen: bool, flagged: bool, answered: bool) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE messages SET seen = ?3, flagged = ?4, answered = ?5 WHERE folder_id = ?1 AND uid = ?2",
        params![folder_id, uid, seen as i64, flagged as i64, answered as i64],
    )?;
    Ok(())
}
```

Dodaj nową funkcję (np. po `set_flags_by_uid`):
```rust
pub fn find_id_by_message_id_hdr(db: &Database, account_id: i64, message_id_hdr: &str) -> Result<Option<i64>, StorageError> {
    let conn = db.conn();
    let result = conn.query_row(
        "SELECT id FROM messages WHERE account_id = ?1 AND message_id_hdr = ?2 AND draft = 0 ORDER BY id ASC LIMIT 1",
        params![account_id, message_id_hdr],
        |row| row.get::<_, i64>(0),
    );
    match result {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(StorageError::Sqlite(e)),
    }
}
```

- [ ] **Step 8: Rozszerz `threads_repo::list_for_folder` o `answered`**

W `crates/am-storage/src/threads_repo.rs`, w SQL `list_for_folder` dodaj kolejną kolemnę (po podzapytaniu z `subject`, przed `FROM threads t`):
```sql
                ,
                (SELECT m2.answered FROM messages m2
                  WHERE m2.thread_id = t.id AND m2.draft = 0 AND m2.deleted = 0
                    AND m2.from_address <> (SELECT a.email FROM accounts a WHERE a.id = t.account_id)
                  ORDER BY m2.date DESC LIMIT 1)
```

W domknięciu `query_map` (indeksy kolumn przesuwają się — nowa kolumna ma indeks 11) dodaj do `ThreadSummary { ... }` po `flagged: ...`:
```rust
            answered: row.get::<_, Option<i64>>(11)?.unwrap_or(0) != 0,
```

W istniejących testach `threads_repo` literały `ThreadSummary` nie są tworzone ręcznie (mapowanie jest w środku funkcji), więc nic więcej tu nie trzeba.

- [ ] **Step 9: Rozszerz parsowanie flag w IMAP**

W `crates/am-protocols/src/imap.rs`:
- `struct FlagState` — po `pub flagged: bool,` dodaj `pub answered: bool,`
- `fn flag_state` — dodaj `let mut answered = false;`, w `match flag` arm `Flag::Answered => answered = true,`, oraz w konstruktorze `FlagState { uid: ..., seen, flagged, answered }`
- `struct FetchedHeader` (~linia 54) — po polu `flagged` dodaj `pub answered: bool,`
- `fn map_header` — dodaj `let mut answered = false;`, w pętli `match flag` arm `Flag::Answered => answered = true,`, oraz w zwracanym `FetchedHeader { ... }` dodaj `answered,`

- [ ] **Step 10: Przekaż `answered` przez warstwę sync**

W `crates/am-sync/src/service.rs`:
- `fn header_from_fetch` — w `NewMessageHeader { ... }` po `flagged: fetched.flagged,` dodaj `answered: fetched.answered,`
- dwa wywołania `messages_repo::set_flags_by_uid(db, folder_id, c.uid, c.seen, c.flagged)?;` (~linie 593 i 598) zmień na `messages_repo::set_flags_by_uid(db, folder_id, c.uid, c.seen, c.flagged, c.answered)?;`

- [ ] **Step 11: Napraw literały `NewMessageHeader` w testach**

Uruchom `cargo build --workspace --tests` i dla każdego błędu „missing field `answered`" w literale `NewMessageHeader { ... }` dopisz `answered: false,` po `flagged: ...,`. Lokalizacje (testy): `crates/am-storage/src/messages_repo.rs`, `crates/am-storage/src/threads_repo.rs`, `crates/am-sync/src/service.rs`, `crates/am-sync/src/engine.rs`, oraz testy integracyjne w `crates/am-sync/tests/*.rs` jeśli kompilator je wskaże. Analogicznie dla ewentualnych literałów `MessageHeader`/`FetchedHeader`/`FlagState`.

- [ ] **Step 12: Test roundtrip answered w storage (failing-first jeśli pisany przed Step 7)**

W `crates/am-storage/src/messages_repo.rs` module `tests` dodaj:
```rust
    #[test]
    fn insert_and_read_answered_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "a@e.com".into(), display_name: "A".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        insert_headers(&db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: Some("<a@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "x@e.com".into(), from_name: None, subject: "Hi".into(), date: 100,
            seen: true, flagged: false, answered: true, has_attachments: false, size: 0, snippet: String::new(),
        }]).unwrap();
        let headers = list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        assert_eq!(headers.len(), 1);
        assert!(headers[0].answered);
    }
```

- [ ] **Step 13: Test parsowania `\Answered` w `flag_state`**

W `crates/am-protocols/src/imap.rs` module `tests` (jeśli istnieje; w przeciwnym razie dodaj minimalny test konstruujący `FlagState` ręcznie) dodaj test sprawdzający, że `FlagState` ma pole `answered` z wartością domyślną false oraz że zmiana na true jest reprezentowalna:
```rust
    #[test]
    fn flag_state_has_answered_field() {
        let fs = FlagState { uid: 1, seen: false, flagged: false, answered: true };
        assert!(fs.answered);
    }
```

- [ ] **Step 14: Test semantyki `answered` w `list_for_folder`**

W `crates/am-storage/src/threads_repo.rs` module `tests` dodaj:
```rust
    #[test]
    fn list_for_folder_answered_reflects_latest_incoming() {
        let db = Database::open_in_memory().unwrap();
        let account = crate::accounts_repo::insert_account(&db, &am_core::account::NewAccount {
            email: "me@e.com".into(), display_name: "Me".into(),
            provider_type: am_core::account::ProviderType::ImapPassword, color: None,
        }).unwrap();
        let folder = crate::folders_repo::upsert_folder(&db, account.id, "INBOX", "Inbox", am_core::folder::FolderType::Inbox).unwrap();
        crate::messages_repo::insert_headers(&db, folder.id, &[
            am_core::message::NewMessageHeader { uid: 1, message_id_hdr: Some("<in1@x>".into()), in_reply_to: None, references_hdr: None,
                from_address: "boss@e.com".into(), from_name: None, subject: "Q".into(), date: 100,
                seen: true, flagged: false, answered: true, has_attachments: false, size: 0, snippet: "".into() },
        ]).unwrap();
        let tid = create(&db, account.id, "q", 100).unwrap();
        for h in crate::messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap() {
            crate::messages_repo::assign_thread(&db, h.id, tid).unwrap();
        }
        recompute(&db, tid).unwrap();
        let s = list_for_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        assert!(s[0].answered, "odpowiedziano na ostatnią przychodzącą");

        crate::messages_repo::insert_headers(&db, folder.id, &[
            am_core::message::NewMessageHeader { uid: 2, message_id_hdr: Some("<in2@x>".into()), in_reply_to: None, references_hdr: None,
                from_address: "boss@e.com".into(), from_name: None, subject: "Re: Q".into(), date: 300,
                seen: false, flagged: false, answered: false, has_attachments: false, size: 0, snippet: "".into() },
        ]).unwrap();
        for h in crate::messages_repo::list_by_folder(&db, folder.id, 10, 0, i64::MAX).unwrap() {
            crate::messages_repo::assign_thread(&db, h.id, tid).unwrap();
        }
        recompute(&db, tid).unwrap();
        let s2 = list_for_folder(&db, folder.id, 10, 0, i64::MAX).unwrap();
        assert!(!s2[0].answered, "nowa nieodpowiedziana przychodząca gasi wskaźnik");
    }
```

- [ ] **Step 15: Zbuduj i uruchom testy całego backendu**

Run: `cargo test -p am-core -p am-storage -p am-protocols -p am-sync --lib`
Expected: PASS (w tym `migration_v16_adds_answered_column`, `insert_and_read_answered_roundtrips`, `flag_state_has_answered_field`, `list_for_folder_answered_reflects_latest_incoming`).

- [ ] **Step 16: Commit**

```bash
git add crates/am-core crates/am-storage crates/am-protocols crates/am-sync
git commit -m "feat(reply-tracking): add answered flag through storage, imap and sync layers"
```

---

## Task 2: Oznaczanie oryginału przy wysłaniu odpowiedzi

Po udanym SMTP, jeśli wiadomość jest odpowiedzią (`in_reply_to` ustawione), znajdź lokalny oryginał i oznacz go `answered` (lokalnie + op `set_flag` → `\Answered` na serwerze).

**Files:**
- Modify: `crates/am-sync/src/send.rs`

**Interfaces:**
- Consumes: `messages_repo::find_id_by_message_id_hdr`, `service::enqueue_flag`, `am_core::message::MessageFlag::Answered` (z Task 1).
- Produces: `fn mark_original_answered(db, account_id, in_reply_to: Option<&str>) -> Result<(), SyncError>`.

- [ ] **Step 1: Test (failing) — oznaczenie oryginału ustawia answered i tworzy op**

W `crates/am-sync/src/send.rs` module `tests` dodaj:
```rust
    #[test]
    fn mark_original_answered_sets_flag_and_enqueues_op() {
        use am_storage::{folders_repo, messages_repo};
        use am_core::folder::FolderType;
        use am_core::message::NewMessageHeader;
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);
        let folder = folders_repo::upsert_folder(&db, account_id, "INBOX", "Inbox", FolderType::Inbox).unwrap();
        messages_repo::insert_headers(&db, folder.id, &[NewMessageHeader {
            uid: 1, message_id_hdr: Some("<orig@x>".into()), in_reply_to: None, references_hdr: None,
            from_address: "boss@e.com".into(), from_name: None, subject: "Q".into(), date: 100,
            seen: true, flagged: false, answered: false, has_attachments: false, size: 0, snippet: String::new(),
        }]).unwrap();
        let orig_id = messages_repo::find_id_by_message_id_hdr(&db, account_id, "<orig@x>").unwrap().unwrap();

        mark_original_answered(&db, account_id, Some("<orig@x>")).unwrap();

        assert!(messages_repo::get_header(&db, orig_id).unwrap().answered);
        let due = queue_repo::list_due(&db, account_id, now_secs() + 1).unwrap();
        assert!(due.iter().any(|o| o.op_type == "set_flag" && o.payload.contains("\"flag\":\"answered\"")));
    }

    #[test]
    fn mark_original_answered_noop_when_no_in_reply_to() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);
        mark_original_answered(&db, account_id, None).unwrap();
        assert!(queue_repo::list_due(&db, account_id, now_secs() + 1).unwrap().is_empty());
    }
```

- [ ] **Step 2: Uruchom — ma paść (brak funkcji)**

Run: `cargo test -p am-sync --lib mark_original_answered`
Expected: FAIL — `mark_original_answered` nie istnieje.

- [ ] **Step 3: Zaimplementuj `mark_original_answered`**

W `crates/am-sync/src/send.rs` (po imporcie; `enqueue_flag` jest w `crate::service`) dodaj:
```rust
fn mark_original_answered(db: &Database, account_id: i64, in_reply_to: Option<&str>) -> Result<(), SyncError> {
    let mid = match in_reply_to {
        Some(m) if !m.trim().is_empty() => m,
        _ => return Ok(()),
    };
    if let Some(original_id) = am_storage::messages_repo::find_id_by_message_id_hdr(db, account_id, mid)? {
        crate::service::enqueue_flag(db, original_id, am_core::message::MessageFlag::Answered, true)?;
    }
    Ok(())
}
```

Jeśli `enqueue_flag` nie jest publiczne dla `send` — jest (`pub fn enqueue_flag`). `StorageError` z `find_id_by_message_id_hdr` konwertuje się na `SyncError` przez istniejące `From` (sprawdź; jeśli brak, użyj `.map_err(SyncError::from)` lub dopasuj do istniejącego wzorca błędów w pliku).

- [ ] **Step 4: Wepnij wywołanie w `drain_outbox`**

W `crates/am-sync/src/send.rs`, w gałęzi `Ok(())` po `sink.emit(SyncEvent::SendSucceeded { account_id });` dodaj:
```rust
                let _ = mark_original_answered(db, account_id, msg.in_reply_to.as_deref());
```

- [ ] **Step 5: Uruchom testy**

Run: `cargo test -p am-sync --lib mark_original_answered`
Expected: PASS (oba testy).

- [ ] **Step 6: Commit**

```bash
git add crates/am-sync/src/send.rs
git commit -m "feat(reply-tracking): mark original message answered after sending a reply"
```

---

## Task 3: Natychmiastowa widoczność własnej odpowiedzi

Po `APPEND` kopii do „Wysłane" w `drain_outbox` wymuś `incremental_sync_folder` tego folderu, by odpowiedź pojawiła się w wątku od razu.

**Files:**
- Modify: `crates/am-sync/src/send.rs`
- Test: `crates/am-sync/tests/send_greenmail.rs`

**Interfaces:**
- Consumes: `crate::service::incremental_sync_folder(db, account_id, folder_id, creds, sink)` (istniejąca; ta sama sygnatura co użycie w `engine.rs`).

- [ ] **Step 1: Zmodyfikuj `drain_outbox` — sync „Wysłane" zaraz po APPEND**

W `crates/am-sync/src/send.rs`, w bloku zapisu kopii do Sent (po `let _ = session.logout().await;` zamykającym sesję APPEND, wewnątrz `if let Some(sent) = ...`) dodaj po zamknięciu sesji:
```rust
                    let _ = crate::service::incremental_sync_folder(db, account_id, sent.id, creds, sink).await;
```
(zmienna `sent` to `&Folder` znaleziony wcześniej; `creds` i `sink` są argumentami `drain_outbox`).

- [ ] **Step 2: Rozszerz test greenmail — odpowiedź widoczna bez ręcznego sync**

W `crates/am-sync/tests/send_greenmail.rs`, w teście `enqueue_and_drain_sends_and_appends_to_sent`, PRZED jawnym `sync_folder(... sent_folder ...)` dodaj asercję, że po samym `drain_outbox` wątek/folder Sent już zawiera wiadomość:
```rust
    let sent_after_drain = messages_repo::list_by_folder(&db, sent_folder.id, 50, 0, i64::MAX)
        .expect("list Sent after drain");
    assert!(
        sent_after_drain.iter().any(|m| m.subject == SEND_SUBJECT),
        "drain_outbox should sync the Sent copy immediately"
    );
```

- [ ] **Step 2b: Uruchom test greenmail (wymaga Dockera)**

Run: `cargo test -p am-sync --test send_greenmail`
Expected: PASS (jeśli brak Dockera — test sam się pomija; wtedy zweryfikuj `cargo build -p am-sync --tests`).

- [ ] **Step 3: Commit**

```bash
git add crates/am-sync/src/send.rs crates/am-sync/tests/send_greenmail.rs
git commit -m "feat(reply-tracking): sync Sent folder immediately after send for instant visibility"
```

---

## Task 4: Frontend — wskaźnik „Odpowiedziano" na liście wątków

Regeneracja bindings i ikona przy wątku, gdy `answered`.

**Files:**
- Regen: `src/ipc/bindings.ts`
- Modify: `src/features/message-list/MessageListPane.tsx`
- Test: `src/features/message-list/MessageListPane.test.tsx` (jeśli istnieje; w przeciwnym razie utwórz minimalny)

**Interfaces:**
- Consumes: `ThreadSummary.answered: boolean` (z regenerowanych bindings).

- [ ] **Step 1: Regeneruj bindings**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` zawiera `answered: boolean` w typach `ThreadSummary` i `MessageHeader`. Zweryfikuj: `rg "answered" src/ipc/bindings.ts`.

- [ ] **Step 2: Test (failing) — ikona pojawia się przy answered**

W teście `MessageListPane` dodaj przypadek renderujący wątek z `answered: true` i sprawdzający obecność elementu z `title="Odpowiedziano"` (oraz brak przy `answered: false`). Wzór mocka wątku skopiuj z istniejących testów listy; dodaj pole `answered`.

```tsx
it("shows answered indicator when thread.answered is true", () => {
  // render z wątkiem { ...base, answered: true }
  expect(screen.getByTitle("Odpowiedziano")).toBeInTheDocument();
});
it("hides answered indicator when thread.answered is false", () => {
  // render z wątkiem { ...base, answered: false }
  expect(screen.queryByTitle("Odpowiedziano")).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Uruchom — ma paść**

Run: `npm run test -- MessageListPane`
Expected: FAIL — brak elementu `title="Odpowiedziano"`.

- [ ] **Step 4: Dodaj ikonę w `MessageListPane.tsx`**

Zaimportuj ikonę: w istniejącym imporcie z `lucide-react` dodaj `Reply`. W rzędzie metadanych wątku (tam, gdzie renderowane są `Star`/spinacz załączników) dodaj:
```tsx
{thread.answered && <Reply size={14} className="thread-row__answered" title="Odpowiedziano" aria-label="Odpowiedziano" />}
```
(dopasuj nazwę klasy do konwencji w pliku; jeśli `title` na ikonie SVG nie jest wykrywany przez test, owiń w `<span title="Odpowiedziano">`).

- [ ] **Step 5: Uruchom test**

Run: `npm run test -- MessageListPane`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ipc/bindings.ts src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(reply-tracking): show answered indicator on thread list"
```

---

## Task 5: Frontend — wskaźnik „Odpowiedziano" w widoku konwersacji

Per wiadomość: ikona przy wiadomościach z `answered === true`.

**Files:**
- Modify: `src/features/reader/ConversationView.tsx`
- Test: `src/features/reader/ConversationView.test.tsx`

**Interfaces:**
- Consumes: `MessageHeader.answered: boolean`.

- [ ] **Step 1: Test (failing)**

W teście `ConversationView` dodaj przypadek: wiadomość z `answered: true` w `useThreadMessages` → element `title="Odpowiedziano"` obecny; przy `answered: false` — nieobecny. Uwaga na baseline: nie modyfikuj istniejących 3 padających testów reply-button.

```tsx
it("shows answered indicator on a message that was answered", () => {
  // mock useThreadMessages → [{ ...msg, answered: true }]
  expect(screen.getByTitle("Odpowiedziano")).toBeInTheDocument();
});
```

- [ ] **Step 2: Uruchom — ma paść**

Run: `npm run test -- ConversationView`
Expected: nowy test FAIL (istniejące 3 reply-button nadal padają — baseline).

- [ ] **Step 3: Dodaj ikonę per wiadomość**

W `ConversationView.tsx`, w nagłówku/metadanych pojedynczej wiadomości dodaj:
```tsx
{message.answered && <Reply size={14} title="Odpowiedziano" aria-label="Odpowiedziano" />}
```
(`Reply` jest już importowane w tym pliku z `lucide-react`).

- [ ] **Step 4: Uruchom test**

Run: `npm run test -- ConversationView`
Expected: nowy test PASS (baseline 3 reply-button nadal padają — bez zmian).

- [ ] **Step 5: Pełny przebieg testów front + back**

Run: `npm run test` oraz `cargo test --workspace`
Expected: brak nowych regresji; jedynie znana baseline (6 vitest) pozostaje.

- [ ] **Step 6: Commit**

```bash
git add src/features/reader/ConversationView.tsx src/features/reader/ConversationView.test.tsx
git commit -m "feat(reply-tracking): show answered indicator per message in conversation view"
```

---

## Self-Review

**Spec coverage:**
- Sekcja 1 (model danych) → Task 1. ✓
- Sekcja 2 (odczyt `\Answered`) → Task 1 (Step 9–10). ✓
- Sekcja 3 (oznaczanie oryginału) → Task 2. ✓
- Sekcja 4 (natychmiastowa widoczność) → Task 3. ✓
- Sekcja 5 (semantyka „ostatnia przychodząca") → Task 1 (Step 8 + test Step 14). ✓
- Sekcja 6 (UI) → Task 4 + Task 5. ✓
- Sekcja 7 (testy) → rozłożone na Task 1/2/3/4/5. ✓
- Zakres: tylko reply (forward ma `in_reply_to=None` → `mark_original_answered` no-op). ✓

**Placeholder scan:** brak „TBD/TODO"; każdy krok zmieniający kod zawiera kod lub dokładną instrukcję edycji z lokalizacją. Step 11 i Step 4 (Task 4) zawierają warunkowe instrukcje („jeśli kompilator wskaże", „jeśli title nie wykrywany") — to świadome, oparte na rzeczywistym kształcie kodu, nie placeholdery.

**Type consistency:**
- `set_flags_by_uid` ma 6 argumentów wszędzie (def. Task 1 Step 7; wywołania Task 1 Step 10). ✓
- `find_id_by_message_id_hdr(db, account_id, &str) -> Result<Option<i64>>` — def. Task 1 Step 7, użycie Task 2 Step 3. ✓
- `mark_original_answered(db, account_id, Option<&str>)` — def. i użycie Task 2. ✓
- `MessageFlag::Answered` + `"answered"` (flag_label) spójne między Task 1 Step 6 a testem Task 2 Step 1 (`"flag":"answered"`). ✓
- `ThreadSummary.answered` / `MessageHeader.answered` (bool) spójne backend↔bindings↔UI. ✓

## Execution Handoff

Plan zapisany do `docs/superpowers/plans/2026-06-24-reply-tracking.md`.
