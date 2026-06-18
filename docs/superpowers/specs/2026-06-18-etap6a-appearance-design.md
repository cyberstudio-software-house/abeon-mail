# Etap 6a — Appearance + szkielet Settings

Data: 2026-06-18
Status: zaakceptowany (design)
Poprzednie: Etap 5 (OAuth + multi-account + smart folders) — DONE @ 61c2b41 (+ live-fixy 062bdc0..0563fdb)

## Kontekst

Etap 6 ("UX power") obejmuje sześć podsystemów: skróty klawiszowe, wyszukiwanie
FTS, etykiety, snooze, gęstość widoku, motywy. To za dużo na jeden spec, więc
etap 6 jest pocięty na pod-etapy realizowane po kolei, każdy z własnym
spec → plan → implementacja:

- **6a — Appearance** (ten dokument): motywy + accent + gęstość + szkielet Settings.
- 6b — Shortcuts + command palette.
- 6c — Full-text search (FTS5).
- 6d — Labels.
- 6e — Snooze.

6a jest pierwszy, bo jest mały, niskoryzykowy i wprowadza dwie rzeczy, z których
korzystają kolejne pod-etapy: trwały store ustawień (SQLite) oraz pełnoekranowy
ekran **Settings**, którego sidebar już przewiduje pozostałe funkcje (Shortcuts →
6b, Snooze → 6e, Rules & Filters → 7).

## Źródło wizualne

`docs/templates/AbeonMail Screens.html` (+ `AbeonMail.html`) to kanoniczny mockup
designu — artefakt referencyjny, **nie** kod uruchamiany w runtime. Ustalony od
etapu 1 wzorzec: design z szablonu jest **portowany** do komponentów React +
`tokens.css`. Ten sam wzorzec obowiązuje cały etap 6 — każdy pod-etap portuje
swój ekran z szablonu i kończy weryfikacją wizualną względem mockupu.

Zaprojektowany w szablonie ekran **Settings**: pełnoekranowy, z sidebar-nav o
ośmiu sekcjach — General / Accounts / Appearance / Signatures / Notifications /
Rules & Filters / Snooze / Shortcuts.

Zaprojektowany panel **Appearance** ("Personalize how AbeonMail looks on this
device"):

- **Theme**: Light / Dark / Auto (radio-cards).
- **Accent color**: 6 swatchy — `#4f46e5` (domyślny, zaznaczony checkiem),
  `#7c3aed`, `#0ea5e9`, `#10b981`, `#ef5d3a`, `#ec4899`.
- **Message density**: Comfortable (Roomy rows) / Compact (More on screen) /
  Dense (Maximum rows).
- Toggle-switche (42×24 px, biała gałka): **Show preview text** ("Display the
  first line of each message"), **Show sender avatars**, **Thread related
  messages together**, **Unread badge in dock**.

Avatary w szablonie to **inicjały na kolorowym kółku** (np. "MF", "GC"), nie
obrazki — 20 px w liście, 42 px w readerze.

## Zakres 6a

### W zakresie

**Szkielet ekranu Settings** (wspólny kontener dla 6b/6e/7):
- Pełnoekranowy overlay (wzorzec jak istniejący Composer), wejście przez ikonę ⚙
  w stopce `MailboxRail`, zamykanie Esc / przyciskiem X.
- Sidebar-nav z ośmioma sekcjami z szablonu.
- W 6a funkcjonalna jest tylko sekcja **Appearance**; pozostałe siedem to
  placeholdery ("Coming soon").

**Sekcja Appearance** (funkcjonalna):
- **Theme** Light / Dark / Auto — dokończenie istniejącego `ThemeProvider`,
  sterowanie `data-theme` na `<html>`.
- **Accent color** — 6 presetów (hexy wyżej), sterowanie zmienną CSS `--accent`;
  `tokens.css` przepięty na `var(--accent)` tam, gdzie dziś jest hardkod akcentu.
- **Message density** — Comfortable / Compact / Dense, sterowanie `data-density`
  na `.shell`, CSS dostraja metryki wierszy listy wiadomości.
- **Show preview text** — toggle, ukrywa `message-row__snippet`.
- **Show sender avatars** — toggle, renderuje avatar z inicjałów (kolor z hasza
  e-maila nadawcy) w wierszach listy wiadomości.

**Persystencja (SQLite — "thick Rust core"):**
- Migracja **V6**: `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
- `am-storage/settings_repo`: `get_setting`, `set_setting`, `get_all_settings`.
- `am-app`: komendy `getSettings` (zwraca mapę) + `setSetting(key, value)`;
  regeneracja bindings.

Klucze ustawień: `appearance.theme`, `appearance.accent`, `appearance.density`,
`appearance.showPreview`, `appearance.showAvatars`.

### Poza zakresem (świadomie odłożone)

- **Thread related messages together** — toggle zmienia logikę zapytań listy
  (płaska vs wątkowa); osobna decyzja behawioralna, nie czysty wygląd.
- **Unread badge in dock** — integracja z OS → etap 7 (notifications / packaging).
- Pozostałe sekcje Settings (General, Accounts edit, Signatures, Notifications,
  Rules & Filters) — wypełnią je 6b/6e/7. W 6a tylko placeholdery.
- Synchronizacja ustawień między maszynami (settings są per-device).

## Architektura

### Backend (Rust)

- `am-storage/migrations/V6__settings.sql` — tabela `settings`.
- `am-storage/settings_repo.rs`:
  - `get_setting(db, key) -> Result<Option<String>>`
  - `set_setting(db, key, value) -> Result<()>` (UPSERT)
  - `get_all_settings(db) -> Result<Vec<(String, String)>>`
- `am-app/commands.rs`: `get_settings() -> Vec<(String,String)>`,
  `set_setting(key, value)`. Rejestracja w `invoke_handler`, regeneracja bindings.

Ustawienia wyglądu to preferencje per-device — nie są danymi domenowymi, ale
trzymane w tej samej bazie SQLite (źródło prawdy), spójnie z architekturą. Brak
walidacji wartości w rdzeniu (poza typem string) — walidacja/whitelist po stronie
frontu (znane klucze i wartości).

### Frontend

- `src/shared/appearance/` — `AppearanceProvider` (rozszerzenie obecnego
  `ThemeProvider`): trzyma theme + accent + density + toggle, ładuje raz przez
  `getSettings`, aplikuje do DOM (`data-theme`, `data-density`, `--accent`),
  zapisuje zmiany przez `setSetting`. Pierwszy paint na sensownych defaultach
  (theme `auto` → `prefers-color-scheme`), reconcile po doczytaniu z DB — bez
  flashu (odczyt lokalnego SQLite jest sub-milisekundowy).
- `src/features/settings/` — `SettingsOverlay`, `SettingsNav`, `AppearanceSection`,
  placeholdery pozostałych sekcji.
- `src/app/store.ts` — `settingsOpen` + `openSettings` / `closeSettings`.
- `MailboxRail` — ikona ⚙ w stopce otwierająca overlay.
- `MessageListPane` / `message-row` — render avatara z inicjałów (gdy
  `showAvatars`), warunkowy snippet (gdy `showPreview`), reakcja na `data-density`.

### Tokeny / CSS

- `tokens.css` — reużycie istniejących tokenów akcentu, dodanie brakujących
  presetów (`#7c3aed`, `#10b981`, `#ef5d3a`) i przepięcie hardkodów akcentu na
  `var(--accent)`.
- Metryki density jako zmienne CSS przełączane przez `.shell[data-density="..."]`
  (wysokość wiersza, padding, rozmiar fontu snippetu).

### Avatary

Inicjały (1–2 znaki z nazwy lub e-maila nadawcy) na kółku, kolor tła
deterministyczny z hasza e-maila (paleta spójna z designem). Brak sieci, brak
Gravatara — zgodnie z offline-first i prywatnością. 20 px w liście wiadomości.

## Data flow

1. Start aplikacji → `AppearanceProvider` woła `getSettings` → mapa.
2. Provider aplikuje `data-theme`, `data-density`, `--accent` na DOM i udostępnia
   wartości + settery przez kontekst.
3. Użytkownik otwiera Settings (⚙) → `AppearanceSection` czyta z kontekstu.
4. Zmiana kontrolki → optymistyczna aktualizacja stanu providera (natychmiastowy
   efekt wizualny) + `setSetting(key, value)` (persystencja).
5. `MessageListPane` czyta `showPreview` / `showAvatars` z kontekstu i renderuje
   odpowiednio; density działa czysto przez CSS.

## Obsługa błędów

- `getSettings` zawodzi (rzadkie) → provider zostaje na defaultach, loguje błąd;
  UI działa.
- `setSetting` zawodzi → stan wizualny pozostaje zmieniony (optymistyczny), błąd
  logowany; przy następnym starcie wróci ostatnia zapisana wartość. Brak twardego
  blokowania UI dla preferencji wyglądu.
- Nieznany klucz/wartość przy odczycie → ignorowany przez whitelist na froncie
  (fallback do defaultu).

## Testy

**Rust:**
- `settings_repo`: roundtrip get/set, UPSERT nadpisuje wartość, `get_all_settings`
  zwraca wszystkie pary, brak klucza → `None`.
- Komendy `get_settings` / `set_setting` (poziom AppState).

**Frontend:**
- `AppearanceSection`: wybór Theme/Accent/Density i toggle wywołują `setSetting`
  z poprawnym kluczem/wartością i aktualizują DOM (`data-theme`/`data-density`/
  `--accent`).
- `SettingsOverlay`: open/close (⚙, X, Esc), nawigacja sidebar, placeholdery.
- `MessageListPane`: respektuje `showPreview` (snippet on/off), `showAvatars`
  (avatar on/off), density (klasa/atrybut).
- Avatar: poprawne inicjały i deterministyczny kolor z e-maila.

## Kryteria ukończenia

- Migracja V6 + `settings_repo` + komendy, pełny `cargo test --workspace` zielony.
- Settings overlay z funkcjonalną sekcją Appearance; pozostałe sekcje jako
  placeholdery.
- Theme / Accent / Density / Show preview text / Show sender avatars działają i
  są persystowane między uruchomieniami.
- **Fidelity check**: uruchomiona aplikacja, Settings → Appearance porównane z
  ekranem z `docs/templates/AbeonMail Screens.html` (układ, kolory, spacing,
  styl toggle-switchy i swatchy) — zgodne.
- Frontend testy zielone; `cargo` + `npm` build czyste.
