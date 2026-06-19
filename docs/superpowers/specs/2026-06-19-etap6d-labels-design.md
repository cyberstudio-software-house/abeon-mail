# Etap 6d — Labels (lokalne, globalne) — Design

**Status:** approved (design), pending plan
**Data:** 2026-06-19
**Poprzednie:** 6c FTS search (@ 638877a)

## Cel

Lokalne, globalne (cross-account) etykiety wiadomości: tworzenie/edycja/usuwanie,
nakładanie z readera i z listy (multi-select), przeglądanie po etykiecie w railu,
zarządzanie w Settings. Bez synchronizacji z serwerem.

## Zablokowane decyzje zakresowe

1. **Synchronizacja:** lokalne (tylko SQLite). Brak zmian w IMAP/sync. Sync etykiet
   z serwerem (IMAP keywords / Gmail X-GM-LABELS) = świadomy tech-debt.
2. **Zasięg:** globalny (cross-account) — jedna lista etykiet dzielona przez wszystkie
   konta, jak smart foldery.
3. **Nakładanie:** z readera (akcja `l`) ORAZ z listy dla zaznaczonych wiadomości
   (nowy tryb multi-select).
4. **Zarządzanie:** inline w pickerze (type-to-create) + pełny CRUD w sekcji
   Settings → Labels.

## Architektura

Etykiety lokalne, cross-account. Budzimy uśpione tabele V1 (`labels`,
`message_labels`), przeprojektowane na globalne. Cienkie repo + komendy w Rust;
picker / chipy / rail / settings w React. Zero zmian w warstwie IMAP/sync.

Kluczowe obserwacje z istniejącego kodu:
- `selectMode` w store to granularność nawigacji j/k (`"thread"|"message"`), NIE
  multi-select. Multi-select to nowy prymityw — rozłączne nazwy (`selectionActive`,
  `selectedMessageIds`).
- Tabela `labels` z V1 jest per-konto (`account_id`, `UNIQUE(account_id,name)`),
  pusta i nieużywana → migracja V8 bezpiecznie `DROP`+`CREATE` z `UNIQUE(name)`.
- Chipy etykiet na liście przez osobny batch-query `labelsForMessages(ids)`, nie przez
  dokładanie kolumn do `SmartMessageRow`/`MessageHeader` — jeden mechanizm dla
  folderów, smart folderów, wyszukiwania i widoku etykiety.

## Model danych — migracja V8

```sql
DROP TABLE IF EXISTS message_labels;
DROP TABLE IF EXISTS labels;
CREATE TABLE labels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE message_labels (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label_id  INTEGER NOT NULL REFERENCES labels(id)   ON DELETE CASCADE,
    PRIMARY KEY (message_id, label_id)
);
CREATE INDEX idx_message_labels_label ON message_labels(label_id);
```

`color` jest `NOT NULL` (przypisywany z palety przy tworzeniu). Kaskada na obu FK.

## Rust — am-core

```rust
pub struct Label {
    pub id: i64,
    pub name: String,
    pub color: String,
}
```
serde + `specta::Type` (jak `SmartMessageRow`).

## Rust — am-storage::labels_repo

- `list_labels(db) -> Vec<Label>` — ORDER BY position, name
- `create_label(db, name, color) -> Label` — INSERT, zwraca wiersz; błąd UNIQUE propagowany
- `rename_label(db, id, name)`
- `set_label_color(db, id, color)`
- `delete_label(db, id)` — kaskada czyści `message_labels`
- `set_message_labels(db, label_id, message_ids: &[i64], applied: bool)` — bulk
  `INSERT OR IGNORE` / `DELETE` w jednej tx
- `labels_for_messages(db, ids: &[i64]) -> Vec<(i64, Label)>` — spłaszczone
  (message_id, Label); do renderu chipów
- `list_messages_by_label(db, label_id, limit, offset) -> Vec<SmartMessageRow>` —
  JOIN przez `message_labels`, reuse `smart_repo::row_to_smart` (pub(crate)),
  wyklucza `draft=1`/`deleted=1`, ORDER BY date DESC (cross-account)

## Rust — am-app komendy

- `listLabels() -> Vec<Label>`
- `createLabel(name, color) -> Label`
- `renameLabel(id, name)`
- `setLabelColor(id, color)`
- `deleteLabel(id)`
- `setMessageLabels(label_id, message_ids, applied)`
- `labelsForMessages(message_ids) -> Vec<(i64, Label)>`
- `listMessagesByLabel(label_id, limit, offset) -> Vec<SmartMessageRow>`

Rejestracja w `collect_commands!`, regen bindings (nowy typ IPC: `Label`).

## Frontend — store

- `selectedLabelId: number | null` — wzajemne wykluczanie z account/folder/smartfolder/
  search; setSelectedLabelId czyści pozostałe, a ich settery czyszczą selectedLabelId.
- Multi-select: `selectionActive: boolean`, `selectedMessageIds: number[]` +
  `toggleSelectionMode()`, `toggleMessageSelected(id)`, `clearSelection()`,
  `selectAll(ids)`.
- `labelPickerOpen: boolean` + `labelPickerTargetIds: number[]`.

## Frontend — queries.ts

- `useLabels()`
- `useMessagesByLabel(labelId)` — enabled gdy labelId != null
- `useLabelsForMessages(ids)` — queryKey na posortowanych ids, zwraca mapę id→Label[]
- mutacje: `useCreateLabel` / `useRenameLabel` / `useSetLabelColor` / `useDeleteLabel` /
  `useSetMessageLabels` — invalidują labels + labelsForMessages + messagesByLabel

## Frontend — komponenty

1. **LabelChips** — kolorowe chipy w wierszach listy (SmartRow + zwykły Row) i w
   nagłówku readera; dane z `useLabelsForMessages`.
2. **LabelPicker** (popover) — input „type-to-create" + lista checkboxów z kropkami
   kolorów; toggle → `setMessageLabels`; Enter na nieistniejącej nazwie → `createLabel`
   (kolejny kolor z palety) + od razu przypięcie. Otwierany z readera (`l`) i z paska
   zaznaczenia listy.
3. **MailboxRail → sekcja Labels** — zastępuje placeholder „Coming soon": żywa lista
   (kropka koloru + nazwa), klik → `selectedLabelId`; „＋ New label".
4. **MessageListPane multi-select** — tryb zaznaczania: checkbox w wierszu + pasek
   zaznaczenia (licznik + „Label" + „Cancel"); banner widoku etykiety „Label: X" +
   licznik (tryb płaski jak smart/search).
5. **Settings → Labels** — tabela: swatch koloru (edytowalny z palety), rename inline,
   delete (confirm), „Add label". Podpięcie pod istniejący placeholder `labels` w
   `SettingsOverlay`.

## Skróty / paleta poleceń

- Akcja `label` (`l`) → `enabled: true`; handler otwiera LabelPicker na bieżącej
  wiadomości/wątku (reader) lub na `selectedMessageIds` (lista w trybie zaznaczania).
- Wpis „Label" w palecie poleceń (enabled) — otwiera picker.

## Paleta kolorów

Stały zestaw ~8 kolorów etykiet (analogicznie do `ACCENT_PRESETS` w
`shared/appearance`). Nowa etykieta dostaje kolejny kolor z palety; Settings pozwala
zmienić.

## Przepływ danych (chipy)

Lista/reader zna widoczne `message_ids` → `useLabelsForMessages(ids)` → mapa
id→Label[] → render chipów. Picker toggluje → invalidacja query → chipy się odświeżają.

## Test-infra

- `lucide-stub.js`: dodać ikonę `Tag` (oraz w razie użycia `Plus`/`Check`), inaczej
  testy OOM (wzorzec z 6-polish).
- Projekt używa `.toBeTruthy()` (brak jest-dom). Token obramowania: `--border-subtle`.
- Nowe komendy: smoke-test w stylu istniejących testów am-app jeśli wzorzec obecny.

## Testy

- **Rust**: `labels_repo` — create/rename/color, delete + kaskada `message_labels`,
  `set_message_labels` apply+remove idempotentnie, `labels_for_messages` mapowanie,
  `list_messages_by_label` cross-account + wyklucza draft/deleted + sortowanie po dacie.
- **Frontend**: store (wzajemne wykluczanie selectedLabelId + slice zaznaczania), hooki
  (enablement/keys), LabelPicker (create-on-type + toggle), MailboxRail (render + klik →
  selectedLabelId), MessageListPane (tryb zaznaczania + chipy), Settings Labels (CRUD),
  registry (`label` enabled + handler otwiera picker).

## Deferred / tech-debt

- Sync etykiet z serwerem (IMAP keywords / Gmail X-GM-LABELS) — poza zakresem (decyzja #1).
- Pełny resync folderu (`delete_by_folder`) gubi etykiety wiadomości; zwykły inkrementalny
  sync je zachowuje (`INSERT OR IGNORE` utrzymuje wiersz po `uid`).
- Ten sam logiczny mail w wielu folderach = osobne wiersze `messages` = etykiety nie
  współdzielone między kopiami.
- Zagnieżdżone etykiety, drag-to-label, filtry kombinowane (etykieta + nieprzeczytane).

## Implementation notes (as built)

Zrealizowano 13 zadaniami (subagent-driven), zmerge'owane do main. Odchylenia i decyzje
do zapamiętania:

- **Multi-select tylko w trybach płaskich** (search / smart folder / widok etykiety, gdzie
  wiersz = wiadomość z `message_id`). W trybie folderów (grupowanym wątkami) NIE ma
  multi-selecta — etykietowanie wątku idzie przez reader (przycisk Tag → picker na ostatniej
  wiadomości wątku). Świadomy zakres MVP.
- **Kolor tekstu chipów** liczony z luminancji tła (`labelTextColor` w `shared/labels/labels.ts`,
  próg 110 → `#000000`/`#ffffff`) — jasne kolory palety (amber `#f59e0b`, sky `#0ea5e9`) dostają
  czarny tekst (czytelność WCAG). Zastąpiło hardcode `color:#fff`.
- **Idempotentne `rename_label`/`set_label_color`/`delete_label`** — brak `NotFound` przy
  nieistniejącym id (świadomy wybór: działa się tylko na widocznych etykietach).
- **`list_messages_by_label`** wyklucza tylko `draft=1`/`deleted=1` (NIE trash/spam) i reużywa
  `smart_repo::row_to_smart`.
- **`to:`-style chipy w liście** przez batch-query `labelsForMessages(visible ids)` — etykietuje
  wszystkie pobrane wiersze (≤100, limit zapytania), nie tylko widoczne w wirtualizerze;
  watch-item przy większej skali, nie problem przy obecnym capie 100.
- GreenMail (Docker) testy integracyjne wymagają pobrania obrazu `greenmail/standalone` — w
  środowisku bez dostępu do Docker Hub (401) nie startują; 6d nie zmienia am-protocols/am-sync,
  więc to ortogonalne do tej zmiany.

### Fast-follow (drobny UX, nie blokuje)

- `rename_label` przy kolizji `UNIQUE(name)` zwraca surowy błąd; `LabelsSection` rename-on-blur
  nie obsługuje błędu → cichy no-op (lista pokazuje starą nazwę). Do dodania: mapowanie błędu +
  revert inputu.
- „New label" w railu otwiera picker z pustą listą targetów (`openLabelPicker([])`) — wejście
  „utwórz etykietę"; istniejące etykiety w pickerze są wtedy klikalne, ale toggle to no-op
  (brak targetów). Rozważyć dedykowane „create label" albo ukrycie toggli gdy brak targetów.
