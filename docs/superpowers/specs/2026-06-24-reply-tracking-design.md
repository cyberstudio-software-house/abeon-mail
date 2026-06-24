# Reply tracking — design (podejście B: hybryda \Answered)

Data: 2026-06-24
Status: zaakceptowany kierunek (podejście B), przed planem implementacji

## Cel

Dwa powiązane wymagania użytkownika:

1. **Lista wiadomości** — widoczny wskaźnik, że odpowiedziałem już na dany wątek.
2. **Widok szczegółów (konwersacja)** — moja odpowiedź widoczna od razu po wysłaniu (dziś pojawia się z opóźnieniem, dopiero po synchronizacji folderu „Wysłane").

## Decyzje (z brainstormingu)

- **Wykrywanie: hybryda.** Oznaczamy lokalnie od razu przy wysyłce z aplikacji ORAZ czytamy/zapisujemy flagę IMAP `\Answered`. Działa natychmiast, synchronizuje się między urządzeniami i wykrywa odpowiedzi wysłane z innych klientów.
- **Semantyka wskaźnika na liście: „odpowiedziałem na ostatnią".** Wątek jest „odpowiedziany", gdy jego najnowsza **przychodząca** wiadomość (od adresu spoza moich kont) ma `answered = 1`. Gdy po mojej odpowiedzi pojawi się nowa przychodząca wiadomość, wskaźnik znika. Wątki zainicjowane przeze mnie (bez wiadomości przychodzących) nie pokazują wskaźnika.
- **Zakres:** tylko `reply` / `reply_all` ustawiają `\Answered`. `forward` jest poza zakresem (to osobna flaga `$Forwarded`). Wskaźnik jest binarny per wątek (nie liczba odpowiedzi).

## Stan obecny (ustalenia z kodu)

- IMAP parsuje wyłącznie `\Seen` i `\Flagged` (`crates/am-protocols/src/imap.rs`, `flag_state()` ok. 503–513 i parser envelope ok. 598–603). `\Answered` jest ignorowane.
- Model `MessageHeader` / `NewMessageHeader` (`crates/am-core/src/message.rs`) ma `seen` i `flagged`, nie ma `answered`.
- `MessageFlag` enum: `Seen`, `Flagged`. Mechanizm flag: `service::enqueue_flag` → `messages_repo::set_flag` (lokalnie) + op `set_flag` w `sync_queue`; drain stosuje przez IMAP `±FLAGS`. Mapowania w `service::flag_label` i `service::imap_flag`.
- Lista folderu pokazuje **wątki** (`list_threads` → `ThreadSummary`), nie pojedyncze wiadomości. `ThreadSummary` (`crates/am-core/src/thread.rs`) ma m.in. `flagged`, nie ma `answered`.
- Widok szczegółów (`ConversationView`) pobiera `useThreadMessages` → `list_thread_messages` → `messages_repo::list_by_thread`, który zwraca wiadomości wątku **niezależnie od folderu** (więc wysłane też), z deduplikacją po `COALESCE(message_id_hdr, 'id:'||id)` (MIN(id)).
- `start_reply` → `compose::build_prefill` zwraca `OutgoingMessage` z ustawionym `in_reply_to` i `references`. Po wysłaniu w `drain_outbox` mamy dostęp do `msg.in_reply_to`.
- `build_message` (`crates/am-mime/src/compose.rs`) buduje MIME przez `mail_builder` (Message-ID generowany wewnętrznie). W `drain_outbox` `bytes` budowane są raz i te same idą do SMTP oraz `APPEND` do „Wysłane".
- Threading: `service::assign_threads(db, account_id)` przypisuje `thread_id` wiadomościom bez wątku (po References → `find_by_message_ids`, w przeciwnym razie po `subject_root`), następnie `threads_repo::recompute`.
- Engine po `drain_outbox` synchronizuje wszystkie foldery (`incremental_sync_folder`) w tym samym przebiegu pętli.
- Ostatnia migracja: `V15__meeting_responses.sql`. Następna: `V16`.

## Projekt

### 1. Model danych

- Migracja `crates/am-storage/src/migrations/V16__answered.sql`:
  `ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;`
- `MessageHeader` + `NewMessageHeader`: pole `answered: bool`.
- `MessageFlag`: nowy wariant `Answered`; `flag_label` → `"answered"`; `imap_flag` → `"\\Answered"`.
- `FlagState` (imap.rs) + `messages_repo::set_flags_by_uid`: dodać `answered` obok `seen`/`flagged`.
- `ThreadSummary`: pole `answered: bool`.
- Zapytania SELECT w `messages_repo` (`list_by_folder`, `list_by_thread`, `get_header`, `row_to_header`/`tuple_to_header`) i insert nagłówków rozszerzone o `answered`.

### 2. Odbiór — czytanie `\Answered`

- `imap.rs`: w `flag_state()` oraz w parserze envelope dodać `Flag::Answered => answered = true`. Zapytania FETCH już pobierają `FLAGS` — bez zmian w query.
- `service.rs`: przy stosowaniu zmian flag (`set_flags_by_uid`) oraz przy wstawianiu nagłówków przenosić `answered`.

### 3. Wysyłka — oznaczanie oryginału

W `send::drain_outbox`, w gałęzi `Ok` po udanym SMTP (po `mark_done` + `SendSucceeded`):

- Jeśli `msg.in_reply_to` = `Some(mid)`: znajdź lokalny oryginał po `message_id_hdr == mid` w tym koncie.
- Jeśli znaleziony: `enqueue_flag(db, original_id, MessageFlag::Answered, true)` — ustawia `answered=1` lokalnie i wrzuca op `set_flag`, który przy drenażu wykona `UID STORE +FLAGS (\Answered)` na serwerze (cross-device).
- `threads_repo::recompute` dla wątku oryginału (wskaźnik aktualizuje się od razu).
- Forward (`in_reply_to == None`) pomijany.

### 4. Natychmiastowa widoczność własnej odpowiedzi (punkt #2)

Po `APPEND` kopii do folderu „Wysłane" w `drain_outbox` wymusić `incremental_sync_folder` dla folderu Sent w tym samym przebiegu (przed kontynuacją pętli). Reużywa istniejącą ścieżkę sync → jeden poprawny rekord z `thread_id` (przez `assign_threads`), bez duplikatów. Oczekiwane opóźnienie ~1–2 s.

Świadomie odrzucone: „optimistic" lokalny insert kopii MIME. Dałby 0 s, ale `Message-ID` jest generowany w `mail_builder` i powstałby drugi rekord (lokalny bez UID + serwerowy z UID) wymagający reconcyliacji. Można dołożyć później, jeśli ~2 s będzie za wolno.

### 5. Wskaźnik na liście — semantyka „ostatnia przychodząca"

`threads_repo` / zapytanie `list_threads`: policz `answered` per wątek jako:

> najnowsza (max `date`, `draft=0`, `deleted=0`) wiadomość przychodząca (`from_address` spoza adresów kont użytkownika) w wątku ma `answered = 1`.

Adresy „moich" kont: z `accounts_repo` (lista e-maili kont). Brak wiadomości przychodzących → `answered = 0`.

### 6. UI

- `MessageListPane`: gdy `thread.answered`, ikona `Reply` (lucide ↩) w rzędzie metadanych wątku (obok gwiazdki/spinacza), `title="Odpowiedziano"`.
- `ConversationView`: przy wiadomościach z `answered === true` mała ikona ↩ „Odpowiedziano". Własna wysłana odpowiedź jest już w wątku dzięki sekcji 4.
- `bindings.ts` regenerowane (specta) po zmianie typów `ThreadSummary` / `MessageHeader`.

### 7. Testy

Rust:
- Migracja V16: kolumna `answered` istnieje, default 0 (wzór jak `migration_v14_adds_is_html_column`).
- `flag_state` parsuje `\Answered`.
- `drain_outbox`: po wysłaniu odpowiedzi (`in_reply_to` ustawione) oryginał ma `answered=1` i powstaje op `set_flag` z `flag="answered"`.
- `list_threads`: `answered` zgodne z semantyką „ostatnia przychodząca" (przypadki: odpowiedziano na ostatnią → 1; nowa przychodząca po odpowiedzi → 0; wątek tylko wychodzący → 0).

Frontend (vitest):
- `MessageListPane` renderuje ikonę przy `answered=true`, nie renderuje przy `false`.
- Mocki `useUiStore` / queries muszą zawierać nowe pola (`ThreadSummary.answered`, `MessageHeader.answered`), inaczej komponenty się wywalą (znana pułapka z w pełni mockowanym store).

## Pliki (orientacyjnie)

- `crates/am-storage/src/migrations/V16__answered.sql` (nowy)
- `crates/am-core/src/message.rs`, `crates/am-core/src/thread.rs`
- `crates/am-protocols/src/imap.rs`
- `crates/am-storage/src/messages_repo.rs`, `crates/am-storage/src/threads_repo.rs`
- `crates/am-sync/src/service.rs`, `crates/am-sync/src/send.rs`
- `crates/am-app/src/commands.rs` (list_threads)
- `src/features/message-list/MessageListPane.tsx`, `src/features/reader/ConversationView.tsx`
- `src/ipc/bindings.ts` (regen)

## Poza zakresem

- Forward jako „odpowiedziano" (`$Forwarded`).
- Optimistic local insert kopii wysłanej (0 s) — ewentualnie później.
- Licznik liczby odpowiedzi w wątku.
