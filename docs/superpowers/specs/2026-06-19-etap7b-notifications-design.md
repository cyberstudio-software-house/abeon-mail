# Etap 7b — Notifications (powiadomienia + unread badge) — Design

**Status:** approved (design), pending plan
**Data:** 2026-06-19
**Poprzednie:** 7a signatures (@ 8ae79b9)
**Kontekst:** drugi pod-etap Etapu 7. Sekwencja: 7a Signatures (DONE) → **7b
Notifications** → 7c General settings → 7d Packaging → 7e Rules & Filters.

## Cel

Powiadomienia systemowe (desktop) o nowej poczcie przychodzącej oraz licznik
nieprzeczytanych (badge) w docku/tasku. Powiadomienie pojawia się tylko dla
nowej poczty w folderach typu Inbox, tylko gdy okno aplikacji jest nieaktywne.
Dedykowana sekcja Settings → Notifications z dwoma przełącznikami. Lokalne, bez
zmian w warstwie sync.

Stan wyjścia: event `NewMessages { account_id, folder_id, count }` jest już
emitowany — wyłącznie z `incremental_sync_folder` (poll/IDLE), gdy
`search_new_uids(uidnext)` znajdzie UID-y powyżej znanego `uidnext` (realnie
nowa poczta w trakcie działania). Pierwszy/pełny sync idzie przez
`sync_all_folders → sync_folder`, które `NewMessages` NIE emitują — brak ryzyka
„burzy" powiadomień przy dodaniu konta. Nagłówki są w bazie (`insert_headers`)
zanim event poleci. Frontend już słucha `newMessages` w `events.ts` (na razie
tylko invaliduje cache). `tauri-plugin-notification` nie jest jeszcze podłączony.

## Zablokowane decyzje zakresowe

1. **Treść:** dla `count == 1` — „<nadawca>: <temat>"; dla `count > 1` —
   agregat „N nowych wiadomości" (z adresem konta). Styl Gmail/Thunderbird.
2. **Focus:** powiadomienia tłumione, gdy okno aplikacji jest aktywne (lista i
   tak się odświeża); powiadamiamy tylko gdy AbeonMail w tle/zminimalizowane.
3. **Zakres:** tylko foldery typu **Inbox** (powiadomienia i badge);
   Sent/Drafts/Spam/Trash/Archive ignorowane.
4. **Orkiestracja:** front (event + ustawienia + focus); logika treści/filtra w
   Rust (testowalna). Bez zmian w `am-sync`/`build_prefill`.

## Architektura

Powiadomienia OS przez `tauri-plugin-notification` (crate Rust + pakiet JS
`@tauri-apps/plugin-notification` + uprawnienie w `capabilities`). **Zero
migracji** — ustawienia na kluczach V6 settings. Badge przez Tauri badge API
(`AppHandle::set_badge_count`).

Podział: testowalna logika (filtr Inbox + komponowanie treści + zliczanie
nieprzeczytanych) w `am-storage`; cienka komenda `am-app`; orkiestracja
(gating ustawieniem, sprawdzenie focusu, faktyczne `sendNotification` i
ustawienie badge) we froncie, gdzie ten stan naturalnie żyje. Zgodne z
filozofią 7a (logika w core, orkiestracja OS/UI tam, gdzie stan).

## Rust — am-core

- `NotificationContent { title: String, body: String }` (serde + specta::Type) —
  nowy typ przekraczający IPC.

## Rust — am-storage (`notifications_repo`)

- `build_new_mail_notification(db, folder_id: i64, count: i64) ->
  Option<NotificationContent>`:
  - folder nie jest typu Inbox → `None`;
  - `count == 1` → najnowszy nagłówek folderu (ORDER BY date DESC LIMIT 1):
    `title` = `from_name` jeśli niepusty, w przeciwnym razie `from_address`;
    `body` = `subject` jeśli niepusty, w przeciwnym razie „(no subject)";
  - `count > 1` → `title` = email konta folderu, `body` = „{count} new messages";
  - brak wierszy dla `count == 1` (race) → `None`.
- `count_inbox_unread(db) -> i64` — suma `folders.unread_count` po folderach
  typu Inbox wszystkich kont.

## Rust — am-app (komendy)

- `build_new_mail_notification(folder_id: i64, count: i64) ->
  Option<NotificationContent>` — delegat do repo.
- `refresh_unread_badge(enabled: bool) -> ()` — gdy `enabled`: liczy
  `count_inbox_unread`, ustawia badge (`app.set_badge_count(Some(n))` dla `n>0`,
  `None` gdy `0`); gdy `false`: czyści badge (`set_badge_count(None)`). Ustawienie
  badge idzie przez `AppHandle` — niemockowalne, bez testu jednostkowego (jak
  inne komendy z `tauri::State`/`AppHandle`).

Rejestracja w `collect_commands!`, regen bindings. `NotificationContent` jako
nowy typ w bindings.

## Rust — src-tauri

- `Cargo.toml`: `tauri-plugin-notification = "2"`.
- `lib.rs`: `.plugin(tauri_plugin_notification::init())`.
- `capabilities/default.json`: dodać `notification:default` (oraz, jeśli
  wymagane przez wersję Tauri, uprawnienie pozwalające `set_badge_count`).
- Komenda `refresh_unread_badge` potrzebuje `AppHandle` (przez `tauri::State`
  lub parametr `app: tauri::AppHandle`).

## Frontend — store / settings

- Store: `notificationsEnabled: boolean`, `badgeEnabled: boolean` + czyste
  settery (bez IPC). Persistencja wyłącznie w `NotificationsProvider`/
  `useNotifications`.
- Klucze V6: `notifications.enabled`, `notifications.badge`. Domyślnie oba `true`
  (powiadomienia bramkowane uprawnieniem OS).

## Frontend — NotificationsProvider / useNotifications

- `NotificationsProvider` (mirror `AppearanceProvider`): ładuje `getSettings` →
  hydratuje store; jeśli `notificationsEnabled` i uprawnienie OS nierozstrzygnięte
  (`isPermissionGranted()` false) → `requestPermission()` raz.
- `useNotifications` — eksponuje przełączniki + persist (`setSetting`).

## Frontend — events.ts

- W listenerze `newMessages` (po istniejącej invalidacji): jeśli
  `notificationsEnabled` i `!getCurrentWindow().isFocused()` →
  `commands.buildNewMailNotification(folder_id, count)`; jeśli wynik `Some` i
  uprawnienie nadane → `sendNotification({ title, body })`.
- Po zdarzeniach zmieniających liczbę nieprzeczytanych z serwera/sync
  (`newMessages` / `mailboxChanged` / `snoozeWoke`) → w `events.ts`
  `commands.refreshUnreadBadge(badgeEnabled)`. Dla lokalnego przeczytania —
  `refreshUnreadBadge` w `onSuccess` mutacji `useMarkSeen` / `useSetMessageFlags`
  w `queries.ts` (markSeen NIE jest eventem, więc nie idzie przez `events.ts`).

## Frontend — Settings → Notifications (`NotificationsSection`)

- Mirror `AppearanceSection`: dwa przełączniki `role="switch"` — „Desktop
  notifications" i „Unread badge". Włączenie powiadomień wywołuje
  `requestPermission()`; gdy odmówiono — komunikat o braku uprawnienia OS.
- Montaż w `SettingsOverlay` pod id `notifications` (placeholder „Coming soon"
  znika).

## Testy

- **Rust**: `build_new_mail_notification` — folder nie-inbox → None; `count==1`
  → nadawca (from_name, fallback from_address) + temat (fallback „(no subject)");
  `count>1` → agregat z liczbą + email konta; brak wierszy → None.
  `count_inbox_unread` — suma po inboxach wielu kont, pomija Sent/Spam/Trash.
- **Frontend**: store (toggle'e); `useNotifications`/`NotificationsProvider`
  (hydratacja + persist + request-permission gdy włączone i nierozstrzygnięte);
  `events.ts` (newMessages przy oknie nieaktywnym → komenda + `sendNotification`;
  przy aktywnym → brak; przy wyłączonym ustawieniu → brak; badge refresh po
  zdarzeniach); `NotificationsSection` (render + toggle persist).
  Mock `@tauri-apps/plugin-notification` (`isPermissionGranted`/`requestPermission`/
  `sendNotification`) i `@tauri-apps/api/window` (`getCurrentWindow().isFocused`).

## Test-infra (utrwalone konwencje z 6a–7a)

- Nowe ikony lucide użyte w kodzie aplikacji (np. `Bell`) MUSZĄ trafić do
  `src/test/lucide-stub.js` — inaczej vitest OOM.
- Nowe komendy/hooki/pola store dodać do mocków w `AppShell.test.tsx` (regresja
  cross-suite widoczna tylko w pełnym `npx vitest run`); jeśli `events.ts`
  zaczyna używać `@tauri-apps/plugin-notification`/`@tauri-apps/api/window`,
  dodać te mocki tam, gdzie `events.ts` jest ładowany w testach.
- Projekt używa `.toBeTruthy()` / `.toBeNull()` (brak jest-dom).
- `tsconfig` ma `noUnusedLocals`/`noUnusedParameters` ON — niekompletne literały
  i nieużyte importy wychodzą dopiero w `npm run build`/tsc (klasa błędów z
  6d/6e/7a), nie w vitest.
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`; testy
  `npx vitest run`, build `npm run build`, bindings `npm run gen:bindings`.

## Deferred / tech-debt

- Dźwięk powiadomień; powiadomienia per-konto (włącz/wyłącz dla konta).
- Akcje w powiadomieniu (klik → otwórz wątek) — wymaga deep-linka do wiadomości
  i fokusowania okna.
- Powiadomienia dla folderów reguł (7e) / nie-inbox; natywne grupowanie
  powiadomień OS.
- Badge liczy nieprzeczytane inboxów; brak osobnego trybu „tylko nowe od
  ostatniego spojrzenia".
- `build_new_mail_notification` przy `count==1` bierze najnowszą wiadomość
  folderu (nie konkretnie „tę nową") — przy równoległym napływie tytuł może
  pokazać innego nadawcę; akceptowalne.
