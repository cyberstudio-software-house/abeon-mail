# Etap 7c — General + Snooze settings — Design

**Status:** approved (design), pending plan
**Data:** 2026-06-19
**Poprzednie:** 7a signatures (@ 8ae79b9), 7b notifications (@ fb046e6)
**Kontekst:** trzeci pod-etap Etapu 7. Sekwencja: 7a Signatures (DONE) → 7b
Notifications (DONE) → **7c General settings** → 7d Packaging → 7e Rules &
Filters.

## Cel

Dwie nowe sekcje w Settings, dziś będące placeholderami „Coming soon":

- **General** — wybór konta domyślnego (otwieranego na starcie) oraz format
  daty/godziny (System / 12h / 24h).
- **Snooze** — dostrojenie czterech zaszytych na sztywno parametrów presetów
  snooze z 6e (godzina poranna, offset „Later today", dzień weekendu, początek
  tygodnia).

Lokalne, bez zmian w warstwie sync ani Rust.

## Zablokowane decyzje zakresowe

1. **Widok startowy:** po uruchomieniu aplikacja otwiera **Inbox konta
   domyślnego** (dziś panel jest pusty — selekcja nie jest persystowana). Wprowadza
   pojęcie „konta domyślnego" wybieranego w sekcji General. NIE budujemy trybu
   „przywróć ostatni folder".
2. **Format daty/godziny:** przełącznik **System / 12h / 24h**, domyślnie
   „System" (= dzisiejsze zachowanie). Dotyczy tylko części godzinowej (`hour12`),
   nie miesiąca/dnia.
3. **Snooze:** konfigurowalne **wszystkie cztery** parametry presetów.
4. **Orkiestracja:** w całości frontend. **Zero Rusta, zero migracji** — klucze
   na istniejącym store V6 settings; resolwowanie Inboxa i liczenie presetów po
   stronie Reacta na istniejących komendach (`list_accounts`, `list_folders`,
   `snooze`).

## Architektura

Wzorzec utrwalony w 6a/6b/7a/7b: dla każdej domeny ustawień plik stałych
`*.ts` (`KEYS` / `DEFAULTS` / `parse`) → Provider (hydratacja z `getSettings` +
persist przez `setSetting`) → slice w `useUiStore` (pola + settery + `hydrate*`)
→ Section w Settings → montaż w `main.tsx` → podpięcie gałęzi w `SettingsOverlay`.

Dwa nowe providery: `GeneralProvider`, `SnoozeProvider` (po jednym na domenę,
spójnie z `AppearanceProvider`/`NotificationsProvider`/`ShortcutsProvider`).

Store settings (V6) to generyczna mapa `key TEXT PRIMARY KEY → value TEXT`;
komendy `get_settings() -> Vec<(String,String)>` i `set_setting(key, value)` już
istnieją. Wartości jako stringi (bool → `"true"`/`"false"`, liczby → dziesiętnie).

## General — konto domyślne + bootstrap startowy

### Klucz i sekcja
- Klucz `general.defaultAccountId` → `id` konta jako string; **pusty string =
  „Automatyczne" (pierwsze konto wg `position`)**. Domyślnie pusty.
- `GeneralSection`: `<select aria-label="Default account">` z opcją
  „Automatic (first account)" (wartość `""`) + lista kont z `list_accounts`
  (etykieta = email). Zmiana → setter w store + persist.

### Bootstrap startowy (`useStartupView`)
Nowy hook montowany w `AppShell`, jednorazowy w sesji (ref-guard):

- **Warunki odpalenia:** konta załadowane (`accounts.length > 0`) **oraz**
  General zhydratowane (flaga `generalHydrated` w store) **oraz** brak
  jakiejkolwiek selekcji (`selectedAccountId`, `selectedFolderId`,
  `selectedSmartFolder`, `selectedLabelId` wszystkie `null`). Flaga
  `generalHydrated` chroni przed przedwczesnym fallbackiem, zanim dojedzie
  zapisany `defaultAccountId`.
- **Resolwowanie konta:** jeśli `defaultAccountId` niepusty i pasuje do
  istniejącego konta → ono; w przeciwnym razie pierwsze konto wg `position`.
  `setSelectedAccountId(resolved)`.
- **Resolwowanie folderu (drugi krok):** gdy foldery wybranego konta się
  załadują (`list_folders`), znajdź `folder_type === "inbox"` →
  `setSelectedFolderId(inbox.id)`. Brak Inboxa (konto jeszcze niezsynchronizowane)
  → konto wybrane, folder pozostaje `null` (pusty panel do czasu sync).
- **Guardy:** ref-guard ustawiany dopiero po udanym wyborze konta, tak by hook
  nie odpalił się ponownie i nie nadpisał późniejszej nawigacji. Gdy na pierwszym
  renderze brak kont — guard NIE jest konsumowany; hook odpali się, gdy konta
  dojadą (np. po dodaniu pierwszego konta).
- **Edge:** usunięte konto domyślne → fallback na pierwsze, bez błędu. Zero kont
  → nic (ekran dodania konta).

## General — format daty/godziny

- Klucz `general.timeFormat` → `"system" | "12h" | "24h"`, domyślnie `"system"`.
  „system" = brak zmiany wyjścia względem dzisiaj (locale przeglądarki).
- Nowy moduł `src/shared/datetime/datetime.ts` (DRY, centralizacja formatowania):
  - `type TimeFormat = "system" | "12h" | "24h"`.
  - `hour12Option(fmt): boolean | undefined` — system→`undefined`, 12h→`true`,
    24h→`false`.
  - czyste formatery przyjmujące `TimeFormat`:
    - `formatListDate(epochSeconds, fmt)` — dziś → godzina (z `hour12`); inaczej
      „MMM d" (bez zmian, format godziny nie dotyczy).
    - `formatMessageTime(epochSeconds, fmt)` — godzina (z `hour12`).
    - `formatWakeTime(epochSeconds, fmt)` — „MMM d, HH:mm" (z `hour12` w części
      godzinowej).
- **Refactor trzech miejsc** na subskrypcję `useUiStore(s => s.timeFormat)` +
  czysty formater:
  - `MessageListPane.tsx` (`formatDate` → `formatListDate`).
  - `reader/ConversationView.tsx` (`formatTime` → `formatMessageTime`).
  - `shared/snooze/snooze.ts` (`formatWakeTime` przyjmuje `fmt`; wołający
    subskrybuje `timeFormat`).
- Zmiana formatu w ustawieniach przerenderowuje listę/reader natychmiast
  (reaktywnie, bo subskrypcja store).

## Snooze — konfigurowalne presety

### Klucze (domyślne = dzisiejsze zaszyte wartości)
- `snooze.morningHour` → 0–23, domyślnie `8` (wspólna godzina dla Tomorrow /
  This weekend / Next week).
- `snooze.laterTodayHours` → 1–12, domyślnie `3` (offset „Later today").
- `snooze.weekendDay` → 0–6 (0 = niedziela … 6 = sobota), domyślnie `6`.
- `snooze.weekStartDay` → 0–6, domyślnie `1` (poniedziałek; „Next week").

### Parametryzacja presetów
`shared/snooze/snooze.ts`:
- nowy typ `SnoozeConfig { morningHour, laterTodayHours, weekendDay, weekStartDay }`.
- `presetTimestamp(kind, now, config)` (rozszerzona sygnatura):
  - `later_today` → `now + config.laterTodayHours * 3600`.
  - `tomorrow` → `tomorrowAt(now, config.morningHour)`.
  - `this_weekend` → `nextWeekdayAt(now, config.weekendDay, config.morningHour)`.
  - `next_week` → `nextWeekdayAt(now, config.weekStartDay, config.morningHour)`.
- `SnoozePicker` czyta config ze store (subskrypcja slice) i przekazuje do
  `presetTimestamp`.

### Sekcja
`SnoozeSection`: cztery `<select>`-y —
- Godzina poranna: `00:00`–`23:00`.
- „Later today" offset: 1–12 h.
- Dzień weekendu: Mon–Sun.
- Początek tygodnia: Mon–Sun.

Każda zmiana → setter w store + persist. Opcjonalny tekstowy podgląd opisu
(„Tomorrow → 08:00", „This weekend → Sat 08:00").

## Store / providery / montaż

- Slice **General**: `defaultAccountId: string`, `timeFormat: TimeFormat`,
  `generalHydrated: boolean` + settery (`setDefaultAccountId`, `setTimeFormat`) +
  `hydrateGeneral(partial)` (ustawia też `generalHydrated = true`).
- Slice **Snooze**: `snoozeMorningHour`, `snoozeLaterTodayHours`,
  `snoozeWeekendDay`, `snoozeWeekStartDay` + settery + `hydrateSnooze(partial)`.
- `main.tsx`: dołożyć `GeneralProvider` + `SnoozeProvider` do drzewa providerów
  (obok Appearance/Notifications/Shortcuts).
- `SettingsOverlay.tsx`: gałąź `general` → `<GeneralSection/>`, `snooze` →
  `<SnoozeSection/>`; placeholdery „Coming soon" dla obu znikają.

## Testy

- **datetime.ts:** `hour12Option` mapowanie; `formatMessageTime`/`formatListDate`
  z `system`/`12h`/`24h` (asercja na `hour12` przez mock `toLocaleTimeString`
  lub sprawdzenie obecności AM/PM vs 24h); „dziś" vs starsza data w
  `formatListDate`.
- **snooze `presetTimestamp(config)`:** `later_today` = +offset; `tomorrow` z
  `morningHour`; `this_weekend` na `weekendDay`+`morningHour`; `next_week` na
  `weekStartDay`+`morningHour`; zmiana configu → inny wynik (deterministyczne
  `now` jak w istniejących testach snooze).
- **parse:** `parseGeneralSettings` (whitelist `timeFormat` ∈ {system,12h,24h};
  `defaultAccountId` dowolny string, śmieć → pominięcie/domyślne);
  `parseSnoozeSettings` (walidacja zakresów godzin 0–23 / dni 0–6 / offset 1–12;
  niepoprawna wartość → odrzucona, zostaje default).
- **`useStartupView`:** wybiera Inbox konta domyślnego; pomija gdy selekcja już
  istnieje; fallback gdy `defaultAccountId` nie pasuje (usunięte konto) → pierwsze
  konto; brak kont → brak akcji; nie odpala się dwa razy.
- **GeneralSection / SnoozeSection:** render + persist po zmianie kontrolki
  (mock `setSetting`).

## Test-infra (utrwalone konwencje 6a–7b)

- Nowe ikony lucide użyte w kodzie aplikacji MUSZĄ trafić do
  `src/test/lucide-stub.js` — inaczej vitest OOM.
- Nowe pola store / hooki dodać do mocków w `AppShell.test.tsx` i innych testach
  ładujących te moduły (regresja cross-suite widoczna tylko w pełnym
  `npx vitest run`). `useStartupView` w `AppShell` wymaga zmockowania
  `useAccounts`/`useFolders` tam, gdzie `AppShell` jest renderowany w testach.
- Projekt używa `.toBeTruthy()` / `.toBeNull()` (brak jest-dom).
- `tsconfig` ma `noUnusedLocals`/`noUnusedParameters` ON — nieużyte importy i
  niekompletne literały wychodzą dopiero w `npm run build`/tsc (klasa
  build-breakerów z 6d/6e/7a/7b), nie w vitest. Po każdym zadaniu: `npx vitest
  run` **i** `npm run build`.
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`; testy
  `npx vitest run`, build `npm run build`. Bindings nie są potrzebne (brak zmian
  Rust/IPC).

## Deferred / tech-debt

- Tryb „przywróć ostatni otwarty folder/konto" (świadomie pominięty na rzecz
  default-account-inbox).
- Konto domyślne jako domyślne „From" w composerze.
- Strefa czasowa, język/i18n, format daty kalendarzowej (12h/24h dotyczy tylko
  godziny).
- Walidacja, że „weekend"/„next week" mają sens względem siebie (dozwolone
  dowolne dni; preset i tak liczy najbliższe wystąpienie).
