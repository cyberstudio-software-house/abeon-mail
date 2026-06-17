# AbeonMail — Specyfikacja projektu

Data: 2026-06-17
Status: zatwierdzona (faza brainstorming)

## 1. Wizja i cele

AbeonMail to wieloplatformowy klient poczty (Linux / Windows / macOS) zbudowany na
Tauri 2 (rdzeń w Rust) z frontendem w React. Priorytety produktu:

1. Doskonały UX i estetyka — bez kompromisów funkcjonalnych.
2. Dostępny na Linux, Windows, macOS.
3. Wiele form autoryzacji (IMAP/POP/SMTP, OAuth Google; docelowo Microsoft, Exchange, Apple).
4. Obsługa wielu kont.
5. Szybkość (offline-first).

### Zakres MVP

MVP to **sama poczta doprowadzona do perfekcji**. PIM (kalendarz, zadania, kontakty)
oraz dodatkowi dostawcy OAuth są poza MVP i wejdą jako osobne moduły/etapy.

| Wymiar | Decyzja MVP |
|---|---|
| Zakres | Poczta (mail-only) |
| Model danych | Pełny offline-first (SQLite + FTS5) |
| Auth w MVP | IMAP/POP/SMTP (hasło, w tym iCloud app-password) + OAuth Google |
| Auth po MVP | Microsoft (Office365/Outlook/Live/Hotmail), Exchange (EWS/Graph), Apple |
| UI | Hybryda: czysto i przestronnie bazowo, tryb gęsty + panel kontekstowy na żądanie |
| Motywy | Light + Dark + Auto od startu |
| Wiele kont | Tak, z widokami zbiorczymi (smart folders) |
| Szyfrowanie bazy | SQLCipher jako opcja poza MVP (sekrety i tak w keychainie OS) |

## 2. Architektura

Wybrano model **"gruby rdzeń Rust, cienki React"** (Opcja A).

- Rust jest jedynym właścicielem prawdy: synchronizacja IMAP/SMTP/POP, parsowanie MIME,
  baza SQLite, indeks FTS, OAuth, sekrety w keychainie OS.
- React renderuje dane otrzymane przez komendy Tauri (`invoke`) i reaguje na eventy
  (`emit`/`listen`). Frontend nigdy nie komunikuje się bezpośrednio z serwerem poczty.
- Ciężkie i wrażliwe operacje żyją w Rust; WebView dostaje lekkie DTO.

### 2.1 Rust core (workspace wielocrate'owy)

```
crates/
  am-core        — typy domenowe (Account, Folder, Message, Thread, Attachment, Label), błędy, traity
  am-storage     — SQLite (repozytoria), migracje, indeks FTS, pliki załączników i ciał
  am-protocols   — IMAP, POP3, SMTP (klienci sieciowi, niskopoziomowo)
  am-mime        — parsowanie/budowanie MIME (treść, nagłówki, załączniki, inline)
  am-sync        — silnik synchronizacji: orkiestracja, kolejka zadań z priorytetami, reconcyliacja
  am-auth        — abstrakcja providerów: PasswordProvider, OAuthProvider (Google), keychain
  am-search      — warstwa zapytań nad FTS (parsowanie zapytań, ranking)
  am-app         — fasada dla Tauri: definicje komend, eventy, stan aplikacji
src-tauri/        — cienki bootstrap: rejestracja komend, okno, tray, updater
```

Granice modułów wymusza kompilator (osobne crate'y). Każdy moduł ma jedną
odpowiedzialność i jawny interfejs; wnętrze można wymienić bez ruszania konsumentów.

### 2.2 Front (React)

```
src/
  app/           — shell, routing, providery kontekstu, motywy (light/dark tokens)
  features/
    mailbox/     — szyna kont + drzewo folderów + labels + smart folders
    message-list/— lista wiadomości (wirtualizowana), gęstość
    reader/      — panel czytania (render HTML w sandbox + sanityzacja)
    composer/    — edytor wiadomości (rich-text/plain), załączniki
    accounts/    — kreator dodawania konta (IMAP autodiscovery + OAuth Google)
    search/      — UI wyszukiwania
    settings/    — General / Accounts / Appearance / Shortcuts / Notifications / Signatures
  shared/        — design system (komponenty UI, tokeny), ipc client, typy DTO
  ipc/           — typowany wrapper na invoke/listen (jedyny punkt styku z Rust)
```

### 2.3 Granica IPC

- Komendy (przykładowo): `add_account`, `list_folders`, `list_messages`, `get_message_body`,
  `send_message`, `mark_flags`, `move_message`, `snooze_message`, `apply_label`, `search`.
- Eventy: `sync_progress`, `new_messages`, `folder_counts_changed`, `account_state_changed`.
- DTO są lekkie: lista wiadomości to nagłówki bez treści; ciało pobierane osobno przy otwarciu.
- Typy DTO i sygnatury komend definiujemy w Rust i generujemy do TypeScript
  (`tauri-specta` + `specta`) — kontrakt jest type-safe po obu stronach.

## 3. Model danych (SQLite, offline-first)

Tożsamość wiadomości w IMAP to para `(UIDVALIDITY, UID)` w obrębie folderu.
Wątkowanie liczymy lokalnie z nagłówków `Message-ID` / `In-Reply-To` / `References`,
niezależnie od serwera.

### 3.1 Główne tabele

```
accounts        — id, display_name, email, provider_type, auth_ref (klucz keychain),
                  settings(json: serwery/porty/TLS), color, position
folders         — id, account_id, remote_path, name, type(inbox/sent/drafts/trash/spam/archive/custom),
                  uidvalidity, uidnext, unread_count, total_count, sync_state
messages        — id, account_id, folder_id, uid, message_id_hdr, thread_id,
                  from, to, cc, subject, date, flags(seen/flagged/answered/draft/deleted),
                  has_attachments, size, snippet, body_state(none/partial/full), snooze_wake_at
message_bodies  — message_id, mime_structure(json), text_plain, text_html, downloaded_at
attachments     — id, message_id, filename, mime_type, size, content_id(inline), blob_ref, downloaded
threads         — id, account_id, subject_root, last_date, message_count, unread_count
labels          — id, account_id, name, color
message_labels  — message_id, label_id
contacts_cache  — id, account_id, email, name, avatar_ref (autouzupełnianie)
signatures      — id, account_id, name, html, is_default
sync_queue      — id, account_id, op_type, payload(json), state, attempts, next_retry_at
search_fts      — wirtualna tabela FTS5: subject, from, to, body_text, attachment_names
```

### 3.2 Decyzje projektowe

- **Załączniki i ciała HTML** trzymane jako pliki na dysku (`blob_ref` = ścieżka), nie w bazie —
  trzyma plik bazy mały i szybki.
- **Akcje offline** (read, move, delete, label, snooze) zapisywane najpierw lokalnie +
  wpis w `sync_queue`. UI reaguje natychmiast (optimistic); `am-sync` odtwarza operacje na
  serwerze idempotentnie z backoffem, gdy jest sieć.
- **Wielokontowość**: każda encja ma `account_id`. Smart foldery (All Inboxes, Unread,
  Flagged, Snoozed, Drafts) to widoki/zapytania ponad kontami, nie osobne dane.
- **Labels vs Folders**: folder = jedna lokalizacja; label = wiele tagów. Gmail (IMAP labels =
  foldery) i pozostali dostawcy (emulacja lokalna) abstrahowani w `am-core` — UI jednolity.
- **Migracje**: wersjonowane (`refinery`).

## 4. Silnik synchronizacji (`am-sync`)

Wykrywamy capabilities serwera i degradujemy łagodnie:
- **CONDSTORE/QRESYNC** — pobieranie tylko zmian od podanego `MODSEQ`.
- **IDLE** — push nowych wiadomości; fallback do pollingu (1–2 min), gdy brak.

### 4.1 Pętla synchronizacji (per konto)

1. Connect & auth — pula połączeń IMAP; osobne połączenie dedykowane na IDLE.
2. Folder discovery — `LIST`, mapowanie na typy, wykrycie special-use.
3. Initial sync — nagłówki (ENVELOPE + FLAGS + struktura) partiami; ciała wg strategii.
4. Incremental sync — QRESYNC/CONDSTORE; inaczej diff po UID + zmiany flag.
5. IDLE — nasłuch zmian w Inbox; fallback polling.
6. Outbox/replay — konsumpcja `sync_queue`: SMTP, zmiany flag, move/delete, APPEND do Sent.

### 4.2 Odporność i priorytety

- `UIDVALIDITY` mismatch → unieważnij lokalne UID-y folderu i re-synchronizuj
  (zachowując ciała po `Message-ID`, by nie pobierać ponownie).
- Priorytety kolejki: akcje użytkownika > sync widocznego folderu > sync w tle.
- Eventy do UI: `sync_progress`, `new_messages`, `folder_counts_changed` — front reaktywny.
- Wysyłka: APPEND do Sent, aktualizacja wątku, **Undo Send** (opóźnienie 5–10 s, konfigurowalne).

### 4.3 Strategia pobierania ciał

- Inbox + ostatnie N dni: pełne ciała + metadane załączników od razu.
- Starsze / inne foldery: nagłówki zawsze, ciało lazy przy pierwszym otwarciu (potem cache trwały).
- Konfigurowalne per konto: "trzymaj offline: 30 dni / wszystko / tylko nagłówki".

### 4.4 Snooze

Mały scheduler: `snooze_wake_at` w bazie + odzwierciedlenie na serwerze przez przeniesienie
do folderu "Snoozed" i powrót do Inbox o zadanej porze — spójne także z webmailem i innymi
urządzeniami.

## 5. Autoryzacja i bezpieczeństwo (`am-auth`)

### 5.1 Abstrakcja providerów (rozszerzalna)

```
trait AuthProvider {
    fn kind() -> ProviderKind;
    async fn authenticate(&self) -> Credentials;     // hasło lub OAuth flow
    async fn access_token(&self) -> Token;            // ważny token (auto-refresh)
    fn imap_smtp_endpoints(&self) -> Endpoints;       // hosty/porty/TLS
}
```

- **PasswordProvider** — IMAP/POP/SMTP z hasłem lub hasłem aplikacyjnym (iCloud, dowolny serwer).
- **GoogleOAuthProvider** — OAuth2 + PKCE, loopback redirect `http://127.0.0.1:<port>`;
  do IMAP/SMTP mechanizm **XOAUTH2** (SASL) z access tokenem; auto-refresh w tle.
- Po MVP: `MicrosoftOAuthProvider`, `ExchangeProvider`, `AppleProvider` — dokładane jako
  implementacje traitu bez ruszania reszty.

PKCE eliminuje potrzebę trzymania client secret w binarce dystrybuowanej publicznie.

### 5.2 Autodiscovery konfiguracji (ręczny IMAP)

Mozilla ISPDB (autoconfig) → rekordy SRV DNS → typowe wzorce (`imap.<domena>`,
`mail.<domena>`) → ręczna korekta. UX: "wpisz e-mail i hasło, resztę wykryjemy".

### 5.3 Sekrety

Refresh tokeny i hasła w keychainie OS (Keychain / Credential Manager / Secret Service)
przez plugin Tauri. Baza trzyma tylko `auth_ref` (referencję), nigdy sam sekret.

### 5.4 Bezpieczeństwo renderingu maili

- Sanityzacja HTML (`ammonia` po stronie Rust) + render w `<iframe sandbox>` z restrykcyjnym CSP.
- Domyślne blokowanie zdalnych obrazów (anty-tracking), przycisk "pokaż obrazy" per nadawca.
- Linki otwierane w przeglądarce systemowej; ostrzeżenie o niezgodności tekstu z URL (anty-phishing).
- Brak wykonywania JS z maili; `target=_blank` + `rel=noopener`.
- Wymuszony TLS (STARTTLS/implicit), walidacja certyfikatów, jawne ostrzeżenie przy self-signed.

## 6. UX, layout i skróty klawiszowe

### 6.1 Layout (hybryda)

- Bazowo 3 panele: szyna kont/folderów → lista wiadomości → panel czytania.
- Przełączniki: tryb kompaktowy/gęsty, opcjonalny prawy panel kontekstowy (detale kontaktu/wątku),
  układ reading pane (z boku / na dole / wyłączony).
- Gęstość listy: Comfortable / Cozy / Compact / Dense.
- Wirtualizacja listy (`@tanstack/react-virtual`) — płynność przy 100k+ wiadomości.
- Smart foldery ponad kontami: All Inboxes, Unread, Flagged, Snoozed, Drafts.

### 6.2 Skróty klawiszowe — podsystem pierwszej klasy

Architektura: **rejestr akcji** (`reply`, `archive`, `next-message`, ...) ↔ **konfigurowalna
mapa wiązań** ↔ trzej konsumenci: skróty, paleta komend, menu. Jedna prawda, brak duplikacji.

- Paleta komend `Ctrl/Cmd+K` — fuzzy search po akcjach i folderach (`cmdk`).
- Domyślny zestaw w stylu Gmaila: `c` compose, `r`/`a` reply/reply-all, `e` archive, `#` delete,
  `j`/`k` nawigacja, `gi`/`gs` go-to-inbox/starred, `u` back to list, `/` search, `?` ściąga.
- Opcjonalny tryb Vim-like (sekwencje, `gg`/`G`) jako profil.
- Pełna konfigurowalność wiązań z wykrywaniem konfliktów; zapis w ustawieniach.
- Ekran ściągi (`?`) generowany z rejestru akcji — zawsze aktualny.
- Skróty kontekstowe (lista vs reader vs composer), respektują focus pól tekstowych.

### 6.3 Kluczowe przepływy

- Dodanie konta: e-mail → autodiscovery → (hasło / "Zaloguj przez Google") → progres initial
  sync z możliwością korzystania w trakcie.
- Composer: rich-text (Tiptap) + tryb plain, załączniki drag&drop, auto-zapis wersji roboczych,
  Undo Send, wklejanie obrazów inline, compose/reply w osobnym oknie.
- Stany: empty states, szkielety ładowania, baner offline z widoczną kolejką akcji,
  błędy auth (ponów logowanie).

### 6.4 Dostępność

Pełna obsługa klawiatury, focus management, ARIA, kontrast WCAG AA, `prefers-reduced-motion`,
`prefers-color-scheme`.

## 7. System wizualny (design tokens)

Źródło: szablony w `docs/templates/` (AbeonMail.html, AbeonMail Screens.html).

- **Akcent (brand): indigo `#4f46e5`** (jaśniejszy `#6366f1`); akcenty pomocnicze
  `#0ea5e9` (sky), `#ec4899` (pink). Akcent konfigurowalny przez użytkownika.
- **Neutralne (lawendowe)**: tła `#efeff7 / #f3f3f8 / #f5f5fb / #f8f8fc`;
  teksty `#1a1a2e / #55556c / #6b6b85 / #9a9ab0 / #b4b4c8`.
- **Ciemne powierzchnie**: `#1a1a2e / #2a2a40` (sidebar / dark theme).
- **Typografia**: Plus Jakarta Sans (system-ui fallback).
- **Motywy**: Light / Dark / Auto jako zestawy tokenów; warstwa stylowania
  (Tailwind vs CSS Modules/vanilla-extract) — decyzja na etapie 1 przy integracji szablonów.

Ustawienia (z szablonów): General / Accounts / Appearance / Shortcuts / Notifications /
Signatures; opcje: theme, accent color, message density, show sender avatars, show preview
text, group by conversation, unread badge w docku, compose/reply w osobnym oknie.

## 8. Stack technologiczny

### 8.1 Rust core

- Runtime: `tokio`.
- IMAP: `async-imap` (IDLE; QRESYNC/CONDSTORE — weryfikacja wsparcia, ew. własne komendy).
- SMTP: `lettre` lub `mail-send` (XOAUTH2, załączniki).
- POP3: `async-pop` lub własny klient.
- MIME: `mail-parser` (parsowanie) + `mail-builder` (budowanie).
- DB: `rusqlite` (bundled SQLite + FTS5) lub `sqlx`; migracje `refinery`.
- OAuth: `oauth2` + własny loopback redirect; XOAUTH2 do IMAP/SMTP.
- Sekrety: plugin keychain Tauri.
- Sanityzacja HTML: `ammonia`.
- Typy → TS: `tauri-specta` + `specta`.

### 8.2 Front

- Tauri 2 + Vite + React 18 + TypeScript.
- Stan serwera/IPC: `@tanstack/query` (invalidation po eventach z Rust) + `zustand` (UI state).
- Wirtualizacja: `@tanstack/react-virtual`.
- Routing: `react-router`.
- Komponenty: headless (Radix / react-aria) + własne tokeny z szablonów.
- Edytor: Tiptap (ProseMirror).
- Paleta komend: `cmdk`.

### 8.3 Multiplatforma i dystrybucja

Buildy CI per OS (Linux AppImage/deb, Windows MSI/NSIS, macOS dmg), podpisywanie +
notaryzacja (Apple) / code-signing (Windows), auto-update (`tauri-plugin-updater`).

## 9. Jakość i wymagania niefunkcjonalne

### 9.1 Testowanie

- Rust: testy jednostkowe per crate; integracyjne sync na lokalnym IMAP w kontenerze
  (GreenMail/Dovecot) — initial sync, flagi, UIDVALIDITY reset, offline replay.
- Parser MIME: golden tests na korpusie "dzikich" maili.
- Front: Vitest + Testing Library; E2E (Playwright / Tauri WebDriver) dla dodania konta,
  wyślij/odbierz, search.
- Kontrakt IPC: typy generowane (`tauri-specta`) + testy serializacji DTO.

### 9.2 Wydajność (cel #5)

- Start do interaktywnej listy: < 1 s (z lokalnej bazy, sync w tle).
- Otwarcie wiadomości z cache: < 50 ms.
- Wyszukiwanie lokalne: < 100 ms dla 100k+ maili.
- Płynne przewijanie 60 fps; rozsądne zużycie RAM przy dużych skrzynkach.

## 10. Etapy realizacji

Każdy etap = osobny cykl spec → plan → implementacja.

1. **Fundament**: workspace, schemat DB, kontrakt IPC, shell UI + design tokeny z szablonów.
2. **Konto IMAP + initial sync**: dodanie konta (hasło/autodiscovery), nagłówki, lista + reader.
3. **Pełny sync**: incremental (QRESYNC/IDLE), ciała lazy, offline queue, wątkowanie.
4. **Wysyłka + composer**: SMTP, Sent, drafts, Undo Send, załączniki.
5. **OAuth Google + wielokontowość + smart foldery.**
6. **UX power**: skróty + paleta komend, search FTS, labels, snooze, gęstość, motywy.
7. **Ustawienia, sygnatury, powiadomienia, packaging/auto-update.**
8. **Po MVP**: OAuth Microsoft, Exchange, Apple, SQLCipher, PIM (kalendarz/zadania/kontakty).
