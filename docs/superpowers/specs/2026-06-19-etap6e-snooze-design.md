# Etap 6e — Snooze (odłóż wiadomość) — Design

**Status:** approved (design), pending plan
**Data:** 2026-06-19
**Poprzednie:** 6d labels (@ 0b81175)

## Cel

Lokalny snooze: użytkownik odkłada wiadomość/wątek do wybranej pory; o tej porze
wiadomość wraca do inboxa oznaczona jako nieprzeczytana. Wyzwalanie z readera
(cały wątek) i z listy (multi-select w trybach płaskich). Dedykowany widok
"Snoozed" w railu. Bez synchronizacji z serwerem.

## Zablokowane decyzje zakresowe

1. **Wyzwalanie:** reader (przycisk zegara + skrót `b`) ORAZ lista (multi-select
   w trybach płaskich: smart foldery / etykiety / wyszukiwanie).
2. **Granularność:** w widoku folderu (grupowanym wątkami) snooze odkłada **całą
   konwersację** — ustawia `snooze_wake_at` na wszystkich wiadomościach wątku.
3. **Presety:** pełny zestaw (Później dziś / Jutro / W ten weekend / W przyszłym
   tygodniu) + własna data/godzina.
4. **Budzenie:** wiadomość wraca do inboxa i zostaje oznaczona jako nieprzeczytana
   (`seen = 0`).

## Architektura

Snooze = lokalny, per-wiadomość znacznik czasu `snooze_wake_at` (kolumna istnieje
w `messages` od migracji V1 — brak migracji schematu danych). Ustawienie znacznika
ukrywa wiadomość/wątek z widoków inbox/folder/smart/etykiety przez filtr
`(snooze_wake_at IS NULL OR snooze_wake_at <= ?now)`. Dedykowany lekki task tokio
("wake-sweeper", tick 60 s) zeruje znaczniki, którym minął czas, oznacza obudzone
wiadomości jako nieprzeczytane i emituje event odświeżający UI. Nowy
`SmartFolderKind::Snoozed` listuje aktualnie odłożone wiadomości z czasem obudzenia.

Konwencja czasu w projekcie: `now: i64` przekazywany parametrem (jak
`queue_repo::list_due`), nie inline `strftime` — testowalne. Komendy liczą `now`
serwerowo i przekazują do repo.

Migracja **V9**: indeks częściowy
`CREATE INDEX idx_messages_snooze ON messages(snooze_wake_at) WHERE snooze_wake_at IS NOT NULL`
— tani wake-sweep i filtr.

## Zakres ukrywania

Odłożone wiadomości znikają z: inbox/folder (lista wątków + lista płaska), smart
folderów (All Inboxes / Unread / Flagged), widoków etykiet. NIE znikają z
wyszukiwania (jawne szukanie znajduje wszystko) ani z widoku Snoozed.

Wątek znika z inboxa tylko gdy wszystkie jego niedraftowe wiadomości są odłożone —
warunek dodany do podzapytania inkluzji w `threads_repo::list_for_folder`. Gdy
przyjdzie nowa odpowiedź (jej `snooze_wake_at` = NULL), wątek wraca samoczynnie
(zachowanie jak w Gmailu — bez dodatkowego kodu).

## Rust — am-core

- `SmartFolderKind` (smart.rs): + wariant `Snoozed`.
- `SmartMessageRow` (smart.rs): + pole `snooze_wake_at: Option<i64>` — wypełniane
  tylko w widoku Snoozed; pozostałe konstruktory (`smart_repo`, `labels_repo`,
  `search_repo`) ustawiają `None`. Dzięki temu widok Snoozed pokazuje czas obudzenia.

## Rust — am-storage

### Migracja V9
```sql
CREATE INDEX idx_messages_snooze ON messages(snooze_wake_at)
WHERE snooze_wake_at IS NOT NULL;
```

### Nowy snooze_repo.rs
- `snooze_messages(db, ids: &[i64], wake_at: i64)` — bulk `UPDATE messages SET
  snooze_wake_at = ?` dla podanych id, jedna tx.
- `unsnooze_messages(db, ids: &[i64])` — `snooze_wake_at = NULL` (bez zmiany `seen`
  — ręczne przywrócenie nie wymusza nieprzeczytanego).
- `wake_due(db, now: i64) -> i64` — dla wiadomości z `snooze_wake_at IS NOT NULL AND
  snooze_wake_at <= now`: ustawia `snooze_wake_at = NULL, seen = 0`; przelicza
  `threads.unread_count` dotkniętych wątków (kolumna zdenormalizowana); zwraca liczbę
  obudzonych wiadomości.
- `list_snoozed(db, now: i64, limit: i64, offset: i64) -> Vec<SmartMessageRow>` —
  `snooze_wake_at IS NOT NULL AND snooze_wake_at > now`, `ORDER BY snooze_wake_at ASC`,
  wyklucza `draft = 0`/`deleted = 0`, wypełnia `snooze_wake_at` w wierszu.

### Filtr "nie-odłożone" (parametr now: i64)
Dodany do (każda funkcja zyskuje parametr `now`):
- `threads_repo::list_for_folder` — w podzapytaniu inkluzji wątku:
  `... AND draft = 0 AND (snooze_wake_at IS NULL OR snooze_wake_at <= ?now)`.
- `messages_repo::list_by_folder`.
- `smart_repo` — `list_all_inboxes`, `list_unread`, `list_flagged`.
- `labels_repo::list_messages_by_label`.
- `list_smart_folder` zyskuje arm `Snoozed → list_snoozed(db, now, ...)` (jedno
  polecenie, frontend bez zmian w pobieraniu).

## Rust — am-app

### Komendy
- `snooze_messages(message_ids: Vec<i64>, wake_at: i64)`
- `unsnooze_messages(message_ids: Vec<i64>)`
- Istniejące `list_threads` / `list_messages` (list_by_folder) / `list_smart_folder`
  / `list_messages_by_label` liczą `now` serwerowo i przekazują do repo.

Rejestracja w `collect_commands!`, regen bindings.

### Event
- Nowy `SnoozeWoke { count: i64 }` w events.rs (+ `SyncEvent` w am-sync, + sink.rs).

### am-sync — wake_sweeper
- W `engine.rs` osobny task tokio (tick 60 s) wołający `snooze_repo::wake_due(db, now)`;
  gdy `count > 0` emituje `SnoozeWoke { count }`. Niezależny od pętli IMAP per-konto —
  budzenie nie czeka na IDLE/poll.

## Frontend — store

- `snoozePickerOpen: boolean`, `snoozePickerTargetIds: number[]` +
  `openSnoozePicker(ids: number[])`, `closeSnoozePicker()`.
- Widok Snoozed = istniejący `selectedSmartFolder = "snoozed"` (wzajemne wykluczanie
  już zaimplementowane dla smart folderów).

## Frontend — queries.ts

- `useSnooze()` — mutacja `snooze_messages`; invaliduje threads / messages / smart /
  labels-for-messages / messages-by-label.
- `useUnsnooze()` — mutacja `unsnooze_messages`; te same invalidacje + smart (Snoozed).
- Widok Snoozed pobiera przez istniejący `useSmartFolder("snoozed")`.

## Frontend — komponenty

1. **SnoozePicker** (`features/snooze/SnoozePicker.tsx` + `.css`) — popover:
   - Presety liczone klientowo w lokalnej strefie: *Później dziś* (+3h), *Jutro*
     (następny dzień 08:00), *W ten weekend* (najbliższa sobota 08:00), *W przyszłym
     tygodniu* (najbliższy poniedziałek 08:00).
   - *Wybierz datę/godzinę* — `<input type="datetime-local">` (bez nowej zależności).
   - Wysyła epoch (s) przez `useSnooze`. Globalny popover montowany w
     `ShortcutsProvider` (jak `LabelPicker`); hooki przed `if (!open) return null`.
   - Pusta lista targetów → no-op.
2. **MailboxRail** — `Snoozed` dołączony do `SMART_FOLDERS` (ikona `Clock`,
   `kind: "snoozed"`); placeholder `aria-disabled` usunięty.
3. **MessageListPane** — widok Snoozed = tryb smart `kind === "snoozed"`; wiersze
   pokazują etykietę czasu obudzenia (z `snooze_wake_at`, format relatywny/krótki);
   pasek zaznaczenia w trybach płaskich dostaje przycisk „Snooze" (→ `openSnoozePicker`),
   a w widoku Snoozed przycisk „Unsnooze" (→ `useUnsnooze`).
4. **ConversationView** — aktywacja przycisku zegara → `openSnoozePicker(<id wiadomości
   wątku>)` (wszystkie wyświetlane wiadomości wątku — snooze całej konwersacji).

## Skróty / paleta poleceń

- Akcja `snooze` (`b`): `enabled: true`, `contexts: ["reader", "list"]`.
- Handler w `ShortcutsProvider`: jeśli `selectionActive && selectedMessageIds.length>0`
  → `openSnoozePicker(selectedMessageIds)`; w innym razie (reader) →
  `openSnoozePicker(<id wiadomości wątku>)`.
- Wpis „Snooze" w palecie poleceń pojawia się automatycznie po `enabled: true`.

## Events → frontend

- `events.ts`: listener `snoozeWoke` → invalidacja folders / messages / threads / smart.

## Test-infra

- `lucide-stub.js`: `Clock` jest; dorzucić użyte nowe ikony (np. `Calendar`), inaczej
  testy OOM.
- Projekt używa `.toBeTruthy()` / `.toBeNull()` (brak jest-dom). Token: `--border-subtle`.
- Cross-suite: nowe hooki/pola store dodać do mocków w `AppShell.test.tsx`
  (regresja widoczna tylko w pełnym przebiegu vitest).

## Testy

- **Rust**: `snooze_repo` — snooze/unsnooze; `list_snoozed` (sortowanie ASC + granica
  `now`); `wake_due` (NULL + `seen=0` + przeliczenie `threads.unread_count` + licznik);
  filtry ukrywania (`threads_repo` — wątek znika gdy wszystkie odłożone, wraca przy
  budziku/nowej wiadomości; `smart_repo` / `labels_repo` / `messages_repo`); arm
  `Snoozed` w `list_smart_folder`.
- **Frontend**: store (picker open/close + targets), hooki (enablement + invalidacja),
  SnoozePicker (presety liczą poprawny ts + custom datetime + wywołanie `snooze` z
  właściwym ts), MailboxRail (render Snoozed + klik → smart folder), MessageListPane
  (wiersze Snoozed + etykieta czasu + toolbar Snooze/Unsnooze), registry (`snooze`
  enabled + handler otwiera picker), reader (przycisk otwiera picker).

## Deferred / tech-debt

- Sync snooze z serwerem (IMAP/Gmail) — poza zakresem (decyzja: lokalne).
- Granularność budzenia 60 s; DST przy granicy zmiany czasu dla presetów lokalnych.
- Snooze pojedynczej wiadomości w trybach płaskich odkłada tylko ją (nie cały wątek)
  — świadome, spójne z multi-select 6d.
- „Wróć gdy ktoś odpisze" działa emergentnie (nowa wiadomość = `snooze_wake_at` NULL →
  wątek wraca do inboxa) — udokumentowane, bez osobnej implementacji.
- Pełny resync folderu (`delete_by_folder`) gubi `snooze_wake_at` razem z wierszem
  (jak etykiety) — inkrementalny sync zachowuje.
