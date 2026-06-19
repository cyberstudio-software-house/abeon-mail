# Etap 7a — Signatures (podpisy) — Design

**Status:** approved (design), pending plan
**Data:** 2026-06-19
**Poprzednie:** 6e snooze (@ 9cb7b4c)
**Kontekst:** pierwszy pod-etap Etapu 7. Sekwencja: **7a Signatures → 7b
Notifications → 7c General settings → 7d Packaging → 7e Rules & Filters**
(zatwierdzona dekompozycja; Rules & Filters jako pełny pod-etap 7e na końcu).

## Cel

Pełna obsługa podpisów per-konto: tworzenie / edycja / usuwanie / wybór
domyślnego w dedykowanej sekcji Settings → Signatures, oraz automatyczne
wstawianie domyślnego podpisu konta przy pisaniu wiadomości (New / Reply /
Reply-all / Forward), z ręcznym pickerem do podmiany. Lokalne, bez synchronizacji
z serwerem.

Stan wyjścia: tabela `signatures` istnieje od migracji V1 (per-konto), ale
`signatures_repo` ma wyłącznie `list_signatures` — brak jakiejkolwiek ścieżki
zapisu i brak UI, więc realnie podpisów dziś nie da się utworzyć. Composer ma
ręczny przycisk „Insert signature", który czyta z (pustej) tabeli.

## Zablokowane decyzje zakresowe

1. **Model:** podpisy **per-konto** (zgodnie z istniejącym schematem
   `signatures.account_id`). Każde konto ma własną listę i swój domyślny.
2. **Auto-insert:** domyślny podpis konta wstawiany **automatycznie na
   wszystkich ścieżkach kompozycji** (New / Reply / Reply-all / Forward); ręczny
   picker nadal dostępny do podmiany.
3. **Pozycja w reply/forward:** podpis **nad cytatem** (styl Gmail — użytkownik
   pisze nad podpisem, podpis nad zacytowaną treścią).
4. **Edytor:** rich HTML przez **TipTap** (StarterKit), ten sam stack co
   composer — zero nowej zależności.
5. **Wstawianie:** realizowane we **froncie** (composer), nie w backendzie —
   pokrywa jednolicie wszystkie ścieżki, podpis pozostaje czystą sprawą UI.

## Architektura

Podpisy = lokalny zasób per-konto. **Zero migracji** — schemat V1
(`signatures(id, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE
CASCADE, name TEXT NOT NULL, html TEXT NOT NULL, is_default INTEGER NOT NULL
DEFAULT 0)`) wystarcza. 7a dokłada warstwę zapisu w `signatures_repo`, komendy
am-app, sekcję Settings i integrację z composerem.

Inwariant domyślności (egzekwowany w logice repo, nie constraintem SQL): *konto
z co najmniej jednym podpisem ma dokładnie jeden domyślny.*

Wstawianie podpisu we froncie: zasada projektu „thick Rust core, thin React"
dotyczy sync / storage / auth, nie składania treści edytora. `build_prefill`
(am-sync) pozostaje bez zmian — pokrywałby tylko reply/forward (New compose go
nie woła) i mieszałby prezentację do warstwy sync.

## Rust — am-core

Bez zmian. Typ `am_core::signature::Signature { id: i64, name: String, html:
String, is_default: bool }` (serde + specta) już istnieje i wystarcza.

## Rust — am-storage (`signatures_repo`)

`list_signatures(db, account_id) -> Vec<Signature>` — już istnieje (ORDER BY id
ASC). Dodawane funkcje:

- `create_signature(db, account_id, name: &str, html: &str, make_default: bool)
  -> Signature` — wstawia wiersz; jeśli to **pierwszy** podpis konta, ustawia
  `is_default = 1` niezależnie od `make_default`; jeśli `make_default` (lub
  pierwszy), w **tej samej** `unchecked_transaction` zeruje `is_default`
  pozostałych podpisów konta. Zwraca utworzony `Signature` (z nadanym `id`).
- `update_signature(db, id, name: &str, html: &str)` — `UPDATE` nazwy i treści;
  idempotentne (brak `NotFound` na nieistniejącym id, jak 6d).
- `set_default_signature(db, account_id, id)` — `unchecked_transaction`:
  `UPDATE signatures SET is_default = 0 WHERE account_id = ?`, potem
  `UPDATE signatures SET is_default = 1 WHERE id = ? AND account_id = ?`.
- `delete_signature(db, id)` — odczytuje `account_id` i `is_default` usuwanego
  wiersza, kasuje go; jeśli był domyślny i konto ma jeszcze inne podpisy,
  **auto-promuje** `MIN(id)` pozostałych na `is_default = 1` (utrzymanie
  inwariantu). Wszystko w jednej transakcji.

Brak nowej kolumny `position` — kolejność = `id ASC` (reorder odłożony).

## Rust — am-app (komendy)

- `create_signature(account_id: i64, name: String, html: String, make_default:
  bool) -> Signature`
- `update_signature(id: i64, name: String, html: String)`
- `set_default_signature(account_id: i64, id: i64)`
- `delete_signature(id: i64)`
- `list_signatures(account_id: i64) -> Vec<Signature>` — już istnieje.

Rejestracja w `collect_commands!`, regen bindings (`npm run gen:bindings`). Typ
`Signature` już eksportowany w bindings — bez nowego typu IPC.

## Frontend — store / queries

- `queries.ts`: `useSignatures(accountId)` (react-query, enabled gdy `accountId
  != null`, klucz `["signatures", accountId]`); mutacje `useCreateSignature` /
  `useUpdateSignature` / `useSetDefaultSignature` / `useDeleteSignature` — każda
  invaliduje `["signatures", accountId]`.
- Store: bez nowego slice'a wymaganego (sekcja Settings trzyma lokalny stan
  edycji; wybór konta = lokalny `useState`). Jeśli wygodne — drobny stan UI w
  komponencie, nie w globalnym store.

## Frontend — Settings → Signatures (`SignaturesSection`, mirror `LabelsSection`)

Sekcja montowana w `SettingsOverlay` pod id `signatures` (placeholder „Coming
soon" znika). Struktura:

- Selektor konta u góry (`<select>` z `useAccounts()`); domyślnie pierwsze lub
  aktualnie wybrane konto. Cała sekcja pracuje na wybranym `accountId`.
- Lista podpisów konta: nazwa + badge „Default" przy domyślnym.
- „New signature" → pole nazwy + edytor TipTap (StarterKit) na treść HTML →
  `createSignature(accountId, name, html, make_default)`.
- Edycja zaznaczonego podpisu: nazwa + edytor TipTap; zapis (on-blur lub
  przycisk Save) → `updateSignature(id, name, html)`.
- „Set default" per wiersz (radio/toggle) → `setDefaultSignature(accountId,
  id)`.
- „Delete" z potwierdzeniem → `deleteSignature(id)`.

Edytor podpisu reużywa zestaw rozszerzeń composera (StarterKit; bez Image —
podpisy to tekst/linki). Sanityzacja treści wychodzącej już zachodzi w
`am-mime::compose::build_message` przy wysyłce, więc podpis przechodzi tą samą
ścieżką co reszta body.

## Frontend — Composer (auto-insert + picker)

**Auto-insert** (świeża kompozycja): warunek `composer.draftId == null` przy
otwarciu = nowa wiadomość / reply / forward (nie wznowiony draft). Raz, pod
guardem `useRef`, po gotowości edytora i ustaleniu `accountId`:

1. Pobierz domyślny podpis konta (`listSignatures(accountId)` →
   `find(is_default)`).
2. Złóż treść edytora: `<p></p>` (pusty akapit — kursor / miejsce na pisanie) →
   **podpis (html)** → `prefill.html_body` (cytat reply/forward, jeśli jest).
   Dla New compose `prefill.html_body` jest pusty → sam pusty akapit + podpis.
3. Ustaw kursor w pustym akapicie na górze.

Wznowiony draft (`composer.draftId != null`) — **nie** wstawia podpisu (zapisana
treść już go zawiera). Brak domyślnego podpisu — brak insertu (pusty edytor /
sam cytat, jak dziś).

**Picker**: dzisiejszy pojedynczy przycisk „Insert signature" → rozwijana lista
podpisów konta (gdy jest >1), wstawia wybrany (również nie-domyślny) w pozycji
kursora przez `editor.insertContent(html)`. Gdy konto ma 0 podpisów — przycisk
ukryty lub disabled.

## Testy

- **Rust** (`signatures_repo`): create (pierwszy podpis → `is_default=1`;
  `make_default=true` zeruje pozostałe); update (zmiana nazwy + html);
  set_default (przełączenie domyślnego między dwoma podpisami konta); delete
  (usunięcie domyślnego → auto-promocja `MIN(id)`; usunięcie nie-domyślnego nie
  rusza domyślnego); izolacja per-konto (operacje na koncie A nie dotykają B).
  am-app: round-trip create → list.
- **Frontend**: `SignaturesSection` (render listy, create, set-default, delete,
  przełączenie konta przeładowuje listę); hooki (mutacje wołają komendę +
  invalidują klucz); composer auto-insert (świeży reply: podpis nad cytatem;
  reopen draftu: brak ponownego wstawienia; brak domyślnego → brak insertu;
  picker wstawia wybrany podpis).

## Test-infra (utrwalone konwencje z 6a–6e)

- Nowe ikony lucide użyte w kodzie aplikacji **muszą** trafić do
  `src/test/lucide-stub.js` — inaczej vitest OOM.
- Nowe komendy / hooki / pola store dodać do mocków w `AppShell.test.tsx` —
  regresja cross-suite widoczna tylko w pełnym `npx vitest run`.
- Projekt używa `.toBeTruthy()` / `.toBeNull()` (brak jest-dom). Token obramowań
  `--border-subtle`.
- `vitest` nie typuje — niekompletne literały TS (np. brak wymaganego pola w
  fixturze) wychodzą dopiero w `npm run build` / tsc (klasa błędów z 6d/6e).
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`; testy
  frontu `npx vitest run`, build `npm run build`.

## Deferred / tech-debt

- Swap podpisu przy zmianie konta „From" w composerze (wymaga zlokalizowania i
  podmiany bloku podpisu — ryzyko duplikatu; odłożone).
- Synchronizacja podpisów z serwerem — poza zakresem (lokalne, jak labels /
  snooze).
- Osobny podpis plain-text (trzymamy tylko `html`; `text_body` composer i tak
  generuje z edytora przy wysyłce).
- Reorder podpisów (kolejność = `id ASC`; brak kolumny `position`).
- Rename / UNIQUE-collision UX — w 7a nazwy podpisów nie mają constraintu
  unikalności (per-konto duplikaty nazw dozwolone; brak potrzeby walidacji).
