# Wskaźnik „trwa wysyłanie" — projekt

Data: 2026-06-22
Status: zaakceptowany projekt, przed planem implementacji

## Cel

Po kliknięciu **Send** użytkownik nie ma żadnej informacji zwrotnej, że wysyłka
trwa — composer zamyka się natychmiast, a faktyczna wysyłka dzieje się
asynchronicznie w tle. Dodajemy nieinwazyjny wskaźnik „trwa wysyłanie" oraz
krótkie potwierdzenie sukcesu.

## Decyzje produktowe

- **Umiejscowienie**: mały popover na dole ekranu (dół-środek).
- **Po sukcesie**: krótkie „Sent ✓" przez ~2,5 s, potem znika.
- **Język tekstów**: angielski, spójnie z resztą UI aplikacji
  (`Sending…`, `Sending (2)…`, `Sent ✓`).
- **Licznik**: przy wielu równoległych wysyłkach pokazujemy liczbę
  (`Sending (2)…`).
- **Błędy**: nie obsługuje ich ten wskaźnik — pozostają w gestii istniejącego
  `SendErrorsBanner` (dół-prawo). Wskaźnik wysyłki tylko znika.

## Stan obecny (kontekst kodu)

- Wysyłka jest „fire-and-forget": `Composer.handleSend` zapisuje draft, woła
  `enqueueSend(draftId)` (op `send_message` w `sync_queue`) i od razu zamyka
  composer. Faktyczna wysyłka: silnik synchronizacji, `am-sync` →
  `send::drain_outbox`.
- Dziś istnieje **tylko** zdarzenie `send-failed` (emitowane raz, przy
  pierwszej porażce, `attempts == 0`). Brak zdarzenia startu i sukcesu.
- Istniejące wzorce do naśladowania:
  - `prefetchProgress` / `setPrefetchProgress` w `src/app/store.ts` — globalny
    stan sterowany zdarzeniem.
  - `SendErrorsBanner` (`src/features/send-errors/`) — popover `position: fixed`
    renderowany w `AppShell`.
  - `RecordingSink` w `crates/am-sync/src/events.rs` — testowy sink zdarzeń.

## Architektura

Wskaźnik żyje w globalnym store (Zustand), bo composer zamyka się przed
zakończeniem wysyłki. Sterowanie zdarzeniami, symetrycznie do `SendFailed`.

Przepływ:

1. Klik **Send** → po udanym `enqueueSend` composer woła `markSendStarted()`
   → `sendingCount++` → popover „Sending…" pojawia się natychmiast.
2. Silnik wysyła w tle. Sukces → backend emituje **nowe** `send-succeeded`
   → front `markSendSucceeded()` → `sendingCount--` i zapis `lastSentAt`.
3. Porażka → istniejące `send-failed` → `markSendFailed()` → `sendingCount--`
   (bez „Sent"; błąd przejmuje `SendErrorsBanner`).
4. Gdy `sendingCount == 0` i `lastSentAt` świeże → popover „Sent ✓" przez
   ~2,5 s, potem znika.

Licznik trzyma front (inkrement przy kliknięciu Send). Backend sygnalizuje
tylko „ta jedna wysyłka się zakończyła" per `account_id`. Prosty licznik
całkowity wystarcza — nie korelujemy konkretnych wiadomości.

### Parzystość increment/decrement i watchdog

W normalnym przebiegu każda wysyłka dekrementuje dokładnie raz:
- sukces → `send-succeeded` (nowe, emitowane per-op),
- porażka SMTP → `send-failed` (istniejące, emitowane per-op przy `attempts == 0`).

Transientne retry nie emitują nic — wskaźnik słusznie pozostaje „Sending…",
bo wysyłka wciąż jest w toku.

**Znane ograniczenie parzystości**: `report_send_setup_failure` (błąd
auth/ustawień konta) emituje *jeden* `SendFailed` na *cały batch* zaległych
wysyłek, nie po jednym na wiadomość. Bez zabezpieczenia, wysłanie ≥2 maili
z konta z zepsutym auth zostawiłoby zawyżony licznik. Świadomie nie zmieniamy
tej logiki backendu (osobny `SendFailed` per-op spamowałby powiadomienia
systemowe).

**Watchdog (źródło prawdy o „nigdy nie wisi")**: licznik realizujemy jako
listę aktywnych tokenów wysyłki, każdy z własnym timerem bezpieczeństwa
(`SEND_WATCHDOG_MS`, np. 5 min). `markSendStarted` dodaje token + timer; realne
zdarzenie (`succeeded`/`failed`) zdejmuje jeden token i **anuluje** jego timer;
jeśli token nie zostanie potwierdzony w czasie watchdoga, timer sam go zdejmuje.
Dzięki temu:
- w normalnym przebiegu watchdog nigdy nie odpala (potwierdzenie go anuluje),
- w edge case (batch setup-failure) brakujące potwierdzenia sprząta watchdog,
  więc wskaźnik zawsze wraca do zera.

`sendingCount` jest wyprowadzony z długości listy tokenów; zdjęcie z pustej
listy jest no-opem (chroni przed nadmiarowym zdarzeniem, np. retry→sukces po
wcześniejszym `send-failed`). Świadomie nie seedujemy stanu z kolejki przy
starcie aplikacji (YAGNI) — restart z zaległymi wysyłkami obsłuży naturalnie
pusta lista + no-op na potwierdzeniach.

## Zmiany — backend (Rust)

`crates/am-sync/src/events.rs`
- Dodać wariant `SyncEvent::SendSucceeded { account_id: i64 }`.

`crates/am-sync/src/send.rs`
- W `drain_outbox`, w gałęzi `Ok(())` po `queue_repo::mark_done(db, op.id)?`:
  `sink.emit(SyncEvent::SendSucceeded { account_id });`

Most do JS (tam, gdzie `SyncEvent` jest mapowane na nazwy zdarzeń Tauri i
emitowane do okna)
- Dodać mapowanie `SendSucceeded` → `"send-succeeded"`.

## Zmiany — frontend

`src/ipc/bindings.ts`
- Typ `SendSucceeded = { account_id: number }`.
- `events.sendSucceeded = makeEvent<SendSucceeded>("send-succeeded")`.

`src/app/store.ts`
- Pola: `sendingCount: number` (init 0, wyprowadzony z liczby aktywnych tokenów),
  `lastSentAt: number | null` (init null). Wewnętrznie lista tokenów z uchwytami
  timerów watchdog.
- Akcje:
  - `markSendStarted()` → dodaje token + `setTimeout(SEND_WATCHDOG_MS)`,
    `sendingCount++`.
  - `markSendSucceeded()` → zdejmuje jeden token i czyści jego timer
    (`clearTimeout`), `sendingCount--`, `lastSentAt = Date.now()`; no-op gdy brak
    tokenów.
  - `markSendFailed()` → zdejmuje jeden token i czyści jego timer,
    `sendingCount--`; no-op gdy brak tokenów.
  - watchdog (wewn.) → po wygaśnięciu zdejmuje swój token, `sendingCount--`
    (bez `lastSentAt`).
- Stała `SEND_WATCHDOG_MS` (np. 300000) — bezpiecznik, nie ścieżka normalna.

`src/ipc/events.ts`
- Nowy listener `events.sendSucceeded.listen(...)` → `markSendSucceeded()`.
- W istniejącym `events.sendFailed.listen(...)` dołożyć `markSendFailed()`.

`src/features/composer/Composer.tsx`
- W `handleSend`, po udanym `enqueueSendMutation.mutateAsync(savedId)`:
  `useUiStore.getState().markSendStarted()`.

`src/features/send-status/SendingIndicator.tsx` (nowy) + `.css`
- Renderowany w `AppShell` obok `SendErrorsBanner`.
- Subskrybuje `sendingCount`, `lastSentAt`.
- Logika widoczności:
  - `sendingCount > 0` → „Sending…" / `Sending (N)…` (N gdy > 1), ikona
    `Loader2` (spin).
  - `sendingCount == 0` i `Date.now() - lastSentAt < 2500` → „Sent ✓", ikona
    `Check`.
  - w innym wypadku → nie renderuje nic.
- Timer `setTimeout(2500)` w `useEffect` wymusza re-render po wygaśnięciu „Sent".
- Pozycja: `position: fixed`, dół-środek; styl/cień wzorowany na
  `SendErrorsBanner.css`. Inna pozycja niż `SendErrorsBanner` (dół-prawo),
  więc się nie nakładają.
- `role="status"`, `aria-live="polite"`.

## Testy

Rust (`crates/am-sync/src/send.rs`)
- Test, że udana wysyłka (`drain_outbox` ze stubem creds/SMTP zwracającym OK)
  emituje `SyncEvent::SendSucceeded { account_id }`. Wzór: `RecordingSink`.

Frontend (vitest)
- `store`: `markSendStarted` inkrementuje; `markSendSucceeded` / `markSendFailed`
  dekrementują i czyszczą timer; potwierdzenie na pustej liście jest no-opem;
  `markSendSucceeded` ustawia `lastSentAt`; watchdog (fake timers) dekrementuje
  po `SEND_WATCHDOG_MS`, a wcześniejsze potwierdzenie anuluje timer.
- `SendingIndicator`: renderuje „Sending…", „Sending (2)…", „Sent ✓" oraz nic
  w stanie spoczynku.

## Poza zakresem (YAGNI)

- Szczegóły wiadomości w popoverze (temat/adresat).
- Seedowanie licznika ze stanu kolejki przy starcie aplikacji.
- Pasek postępu / procenty — wysyłka jest atomowa per wiadomość.
- Anulowanie wysyłki z poziomu wskaźnika.
