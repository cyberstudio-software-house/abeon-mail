# Multi-select wiadomości + panel akcji masowych

Data: 2026-06-21
Status: zatwierdzony do planowania

## Cel

Umożliwić zaznaczanie wielu wiadomości na liście za pomocą myszy (shift / ctrl-klik),
a po zaznaczeniu 2+ pozycji pokazać w prawym panelu informację „Zaznaczono X" wraz z
akcjami masowymi: oznacz jako przeczytane, oznacz jako nieprzeczytane, przenieś do
archiwum, usuń, przenieś do folderu (z wyborem celu), etykieta, drzemka.

## Zakres (ustalenia z brainstormingu)

1. Działa we **wszystkich widokach**: tryb wątkowy (inbox/foldery, wiersze = `thread_id`)
   oraz tryb płaski (search/etykiety/smart-foldery, wiersze = `message_id`).
2. Stary mechanizm zaznaczania w trybie płaskim (przycisk „Select" + checkboxy + pasek
   akcji nad listą) zostaje **zastąpiony** nowym, jednolitym modelem.
3. Panel akcji zawiera **7 akcji**: mark read, mark unread, archive, delete,
   move-to-folder, label, snooze.
4. „Przenieś do folderu" działa tylko dla zaznaczenia z **jednego konta**. Gdy zaznaczenie
   obejmuje >1 konto, akcja jest niedostępna (wyszarzona).

## Interakcja

| Gest | Efekt |
|------|-------|
| Zwykły klik | zaznacza tylko ten wiersz i otwiera go w czytniku |
| Ctrl/Cmd-klik | przełącza wiersz w/poza zaznaczenie (multi) |
| Shift-klik | zaznacza zakres od kotwicy do klikniętego wiersza |

Próg panelu w prawym oknie:
- `selectedRowIds.length >= 2` → panel akcji masowych,
- `=== 1` → istniejący czytnik (`ConversationView` / `MessageReader`),
- `0` → pusty stan.

## Model stanu (`src/app/store.ts`)

Usuwane pola/akcje (stary mechanizm): `selectionActive`, `selectedMessageIds`,
`toggleSelectionMode`, `toggleMessageSelected`, `selectAll`.

Dodawane:

| Element | Rola |
|---------|------|
| `selectedRowIds: number[]` | zaznaczone wiersze; `thread_id` w trybie wątkowym, `message_id` w płaskim |
| `selectionAnchorId: number \| null` | kotwica dla shift-zakresu |
| `rowAccounts: Record<number, number>` | rowId → accountId; ustawiane przez `setListContext` |
| `selectRow(id)` | zwykły klik: `selectedRowIds=[id]`, kotwica=id, ustawia wskaźnik otwarcia |
| `toggleRow(id)` | ctrl/cmd: przełącza id w zbiorze, aktualizuje kotwicę i wskaźnik otwarcia |
| `selectRangeTo(id)` | shift: zakres po `visibleMessageIds` od kotwicy do id |
| `clearSelection()` | czyści `selectedRowIds` + kotwicę |

### Niezmiennik synchronizacji

`selectedThreadId` / `selectedMessageId` (wskaźnik „otwartej pozycji" używany przez
nawigację j/k, auto-mark-read, detekcję kontekstu skrótów) **pozostają**. Zasady:

- `length === 1` → wskaźnik wskazuje na ten jeden element (cały dotychczasowy kod
  jedno-elementowy działa bez zmian),
- `length >= 2` → czytnik ignoruje wskaźnik i pokazuje panel masowy; wskaźnik może
  pozostać na kotwicy (nieszkodliwie),
- `length === 0` → wskaźniki `null`.

Setery `setSelectedThreadId` / `setSelectedMessageId` dodatkowo ustawiają
`selectedRowIds=[id]` + kotwicę, dzięki czemu nawigacja klawiaturą i klik myszą są
spójne. `toggleRow` / `selectRangeTo` czytają `selectMode`, by ustawić właściwy wskaźnik
(thread vs message), gdy zaznaczenie zejdzie do jednej pozycji.

Zmiana folderu/konta/smart-folderu/etykiety oraz wyszukiwanie czyszczą zaznaczenie
(`selectedRowIds`, kotwica) w odpowiednich seterach.

## Lista (`src/features/message-list/MessageListPane.tsx`)

- Usunięcie: przycisk „Select", checkboxy w `SmartRow`, pasek akcji nad listą
  (`message-list__selection-bar`).
- Wspólny handler kliknięcia dla `ThreadRow` i `SmartRow`:
  - `e.shiftKey` → `selectRangeTo(rowId)`,
  - `e.metaKey || e.ctrlKey` → `toggleRow(rowId)`,
  - w przeciwnym razie → `selectRow(rowId)` (tj. `setSelectedThreadId` w trybie wątkowym /
    `setSelectedMessageId` w płaskim).
- Podświetlenie wiersza: `selectedRowIds.includes(id)` zamiast `selectedThreadId === id`
  / `selectedMessageId === id`.
- `setListContext` rozszerzony o mapę `rowId → account_id` (oba typy wierszy mają
  `account_id`); zakres shift liczony po `visibleMessageIds` (czysta lista id w kolejności
  widoku, bez nagłówków grup).

## Prawy panel (`src/features/reader/`)

- `ReaderPane.tsx`: gdy `selectedRowIds.length >= 2` → `BulkActionPanel`, w przeciwnym
  razie dotychczasowa logika czytnika.
- Nowy `BulkActionPanel.tsx`:
  - nagłówek „Zaznaczono X",
  - przyciski: Oznacz jako przeczytane / nieprzeczytane / Przenieś do archiwum / Usuń /
    Przenieś do folderu… / Etykieta… / Drzemka…,
  - liczność = `selectedRowIds.length`,
  - `distinctAccounts = unique(selectedRowIds.map(id => rowAccounts[id]))`;
    move-to-folder aktywne tylko gdy `distinctAccounts.length === 1`
    (`targetAccountId = distinctAccounts[0]`),
  - rozwiązywanie `message_id[]` leniwie przy kliknięciu akcji: w trybie płaskim
    `selectedRowIds` to już `message_id`; w trybie wątkowym wołane jest
    `commands.messageIdsForThreads(threadIds)`.
  - akcje wołają istniejące hooki (`useSetSeen`, `useArchive`, `useDelete`,
    `openLabelPicker`, `openSnoozePicker`) oraz nowy `openFolderPicker`;
    archive/delete/move pokazują undo toast i czyszczą zaznaczenie.

## Picker folderu (`src/features/mailbox/FolderPicker.tsx` lub `src/features/reader/`)

Wzorowany na `LabelPicker` / `SnoozePicker`.

- Stan w store: `folderPickerOpen`, `folderPickerTargetIds`, `folderPickerAccountId`,
  `openFolderPicker(ids, accountId)`, `closeFolderPicker()`.
- Montowany w `ShortcutsProvider` obok pozostałych pickerów.
- Lista folderów konta (`useFolders(accountId)`): **custom + standardowe, z pominięciem
  Drafts / Sent / Trash**.
- Wybór folderu → `useMoveToFolder.mutate({ messageIds, targetFolderId })` + undo toast
  (rodzaj `"move"`) + `clearSelection()` + `closeFolderPicker()`.

## Backend (Rust)

### `crates/am-sync/src/service.rs`
- Nowa funkcja `enqueue_move_to_folder(db, message_id, target_folder_id, now)` — wzorowana
  na `enqueue_move`, ale payload zawiera `target_type: "folder"` oraz `target_folder_id`.
- `drain_one_move`: obsługa `Some("folder")` → cel `dst = folders_repo::get_folder(db,
  target_folder_id)` zamiast `find_by_type`.
- Undo jest generyczne po typie op `move_message` — działa bez zmian.

### `crates/am-app/src/commands.rs`
- `move_messages(state, message_ids: Vec<i64>, target_folder_id: i64)` — iteruje
  `enqueue_move_to_folder`.
- `message_ids_for_threads(state, thread_ids: Vec<i64>) -> Vec<i64>` — zwraca id
  wiadomości dla zadanych wątków (repo: rozszerzenie `threads_repo`/`messages_repo`).
- Rejestracja obu komend w handlerze Tauri/specta.

### Bindingi
- `npm run gen:bindings` (cargo `export_bindings`) regeneruje `src/ipc/bindings.ts`.

### `src/ipc/queries.ts`
- `useMoveToFolder` korzystający z istniejącego `invalidateAfterMove`.
- (opcjonalnie) hook na `messageIdsForThreads` albo wywołanie bezpośrednie w panelu.
- `undoToast` rozszerzony o rodzaj `"move"` (oraz `UndoBar` o tekst dla move).

## Sprzężenia do aktualizacji

- `src/features/shortcuts/ShortcutsProvider.tsx`: `doMove`, `label`, `snooze` czytają
  stary `selectionActive` / `selectedMessageIds` → przepiąć na `selectedRowIds`
  (+ rozwiązanie thread→message w trybie wątkowym). Skróty `e`/`#`/`I`/`U`/`l`/`b`
  działają masowo gdy `selectedRowIds.length >= 1`. Dodać montaż `FolderPicker`.
- `src/features/shortcuts/CommandPalette.tsx`: odwołania do starego stanu zaznaczenia.

## Testy

- Przepisać testy zakładające stary mechanizm (przycisk „Select", checkboxy):
  `src/features/message-list/MessageListPane.test.tsx` i powiązane mocki store w
  `AppShell.test.tsx`, `MailboxRail.*.test.tsx`.
- Nowe testy:
  - shift-klik zaznacza zakres; ctrl/cmd-klik przełącza pojedynczo; zwykły klik resetuje
    do jednego + otwiera,
  - próg `>= 2` pokazuje `BulkActionPanel` z poprawną liczbą,
  - move-to-folder wyszarzone gdy zaznaczenie obejmuje >1 konto,
  - warstwa `queries`: `useMoveToFolder` woła `move_messages` i unieważnia zapytania,
  - (Rust) `enqueue_move_to_folder` + `drain_one_move` dla `target_type:"folder"`.

## Odrzucona alternatywa

Całkowite wyprowadzenie „otwartej pozycji" z `selectedRowIds` (usunięcie
`selectedThreadId` / `selectedMessageId`). Odrzucone — te pola są używane w wielu miejscach
(nawigacja, auto-mark-read, detekcja kontekstu skrótów); refaktor ryzykowny bez realnej
korzyści. Wybrane podejście (synchronizacja przez setery) jest mniej inwazyjne.
