# Akcje folderów w menu kontekstowym

Data: 2026-06-21
Status: zatwierdzony do planowania

## Cel

Rozszerzyć menu kontekstowe folderu (dziś tylko Przypnij/Odepnij) o cztery
akcje: oznacz jako przeczytane, zmień nazwę, usuń, nowy podfolder.

## Decyzje projektowe

- **Jeden spec** obejmuje wszystkie cztery akcje.
- **Model hybrydowy:**
  - `mark-as-read` → przez `sync_queue` (wzorzec `set_flag`: optymistyczna
    zmiana w DB + enqueue + drain wykonuje IMAP, retry). Działa offline.
  - `rename` / `delete` / `create-subfolder` → komendy `async` „na żywo":
    połączenie IMAP, operacja, `discover_folders()` rekoncyliuje lokalną tabelę.
    Bez nowych typów op w kolejce, natychmiastowa poprawność struktury.
- **Polityka dostępności per typ folderu:**

  | Typ folderu | mark-read | pin/unpin | rename | delete | nowy podfolder |
  |---|:---:|:---:|:---:|:---:|:---:|
  | inbox | tak | – | – | – | tak |
  | custom | tak | tak | tak | tak | tak |
  | sent/drafts/trash/spam/archive | tak | tak | – | – | – |

  Jeśli dla danego folderu lista pozycji jest pusta, menu się nie otwiera.
  Znika wcześniejsza reguła „inbox = brak menu".
- **Usuwanie** zawsze przez dialog potwierdzenia z nazwą folderu; jeśli serwer
  odrzuci DELETE (np. niepusty folder/podfoldery) — komunikat błędu, bez cichego
  połykania.
- **Nowy podfolder** tworzony pod klikniętym folderem
  (`parent_path + delimiter + name`).

## Backend (Rust)

### `crates/am-protocols/src/imap.rs`
- `rename_folder(old_path, new_path)` — opakowanie async-imap `rename`.
- `delete_folder(path)` — opakowanie async-imap `delete`.
- `mark_all_seen()` — `UID STORE 1:* +FLAGS.SILENT (\Seen)` na wybranym
  folderze (bulk dla drainu).
- `create_folder(full_path)` — istnieje; używany z pełną ścieżką podfolderu.
- Delimiter hierarchii brany z odpowiedzi LIST; jeśli `RemoteFolder` nie niesie
  delimitera, dodać pole (dostępne z `Name::delimiter()` async-imap).

### `crates/am-sync/src/service.rs`
- `enqueue_mark_folder_read(db, folder_id)`:
  - optymistycznie: `messages_repo::mark_folder_seen` (UPDATE messages SET
    seen=1 WHERE folder_id=? AND seen=0) → `folders_repo::recount_unread` →
    `threads_repo::recompute` dla dotkniętych wątków,
  - enqueue jednej op `"mark_folder_read"` z payloadem `{folder_id, uidvalidity}`,
  - drain: select folderu + `session.mark_all_seen()`.
- `async rename_folder(db, folder_id, new_name, creds)`: nowa ścieżka =
  `remote_path` z ostatnim segmentem zamienionym na `new_name`; connect →
  `rename_folder` → logout → `discover_folders`.
- `async delete_folder(db, folder_id, creds)`: connect → `delete_folder` →
  logout → jawne lokalne usunięcie folderu i jego wiadomości →
  `discover_folders`.
- `async create_subfolder(db, parent_folder_id, name, creds)`: connect →
  ustalenie delimitera → `create_folder(parent + delim + name)` → logout →
  `discover_folders`.

### `crates/am-app/src/commands.rs` + `lib.rs`
- `mark_folder_read(folder_id)` — sync, woła `enqueue_mark_folder_read`.
- `rename_folder(folder_id, new_name)` / `delete_folder(folder_id)` /
  `create_subfolder(parent_folder_id, name)` — `async`, biorą
  `Arc::clone(&state.creds)` i wołają funkcje serwisu z `creds.as_ref()`.
- Rejestracja czterech komend w `collect_commands!` (lib.rs).
- Regeneracja bindingów: `npm run gen:bindings`.

## Frontend

### `src/ipc/queries.ts`
- `useMarkFolderRead()` → `commands.markFolderRead(folderId)`; invaliduje
  `["messages"]`, `["threads"]`, `["folders"]`, `["smart"]` + odświeżenie badge.
- `useRenameFolder()` → `commands.renameFolder(folderId, newName)`; invaliduje
  `["folders"]`.
- `useCreateSubfolder()` → `commands.createSubfolder(parentId, name)`;
  invaliduje `["folders"]`.
- `useDeleteFolder()` → `commands.deleteFolder(folderId)`; invaliduje
  `["folders"]`, `["messages"]`, `["threads"]`, `["smart"]`; jeśli usunięty
  folder był zaznaczony, czyści selekcję.

### Komponenty dialogów (wzorzec wyjęty z `LabelPicker`)
- `TextInputDialog` — modal: tytuł, input, przycisk zatwierdź/anuluj,
  Enter=zatwierdź, Esc/klik poza=anuluj. Użycia: rename (prefill bieżącą nazwą),
  nowy podfolder (puste pole).
- `ConfirmDialog` — modal potwierdzenia (nazwa folderu + ostrzeżenie) dla
  usuwania.

### `src/features/mailbox/MailboxRail.tsx`
- Handler menu kontekstowego: zamiast early-return dla inboxa, builder
  `ContextMenuItem[]` wg polityki per typ. Pusta lista → menu się nie otwiera.
- Pozycje: mark-read (zawsze), pin/unpin (nie-inbox), rename/delete (custom),
  nowy podfolder (inbox + custom).
- rename/create otwierają `TextInputDialog`, delete otwiera `ConfirmDialog`;
  stan otwartego dialogu (rodzaj + folder docelowy) trzymany w railu.

## Obsługa błędów
- `mark-read` (kolejka): błędy obsługuje istniejący retry/zapis porażek drainu
  (jak przy move).
- struktura (live): komenda zwraca `Result`; `onError` mutacji → krótki toast
  z komunikatem (np. odrzucony niepusty folder). Bez cichego połykania.

## Testy
- Rust unit: optymistyczny stan + enqueue dla `mark_folder_read`; obliczanie
  ścieżki przy rename i tworzeniu podfolderu; lokalne czyszczenie przy delete.
  Operacje IMAP „na żywo" — przez istniejący harness e2e GreenMail, jeśli pokrywa.
- Frontend: testy `TextInputDialog` i `ConfirmDialog`; testy hooków (mock
  `commands`); test menu railu (pozycje per typ folderu; dialog → zatwierdzenie
  → wywołanie właściwej mutacji).

## Zależności do dopięcia w planie
- Dokładny mechanizm pobrania delimitera (pole w `RemoteFolder` vs LIST).
- Wzorzec uruchomienia async IMAP z komendy + budowa `CredentialSource`
  (jak `get_message_body` / `start_reply` / `discover_folders`).
- Czy `folders` ma `ON DELETE CASCADE` na `messages` — jeśli nie, jawne usunięcie
  wiadomości przy delete folderu.
