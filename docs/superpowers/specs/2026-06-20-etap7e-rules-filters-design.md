# Etap 7e — Rules & Filters — Design

**Status:** approved (design), pending plan
**Data:** 2026-06-20
**Poprzednie:** 7a–7c (DONE), 7d packaging (równolegle projektowany)
**Kontekst:** piąty/ostatni pod-etap Etapu 7. Sekwencja: 7a → 7b → 7c (DONE) →
7d Packaging → **7e Rules & Filters**.

## Cel

Lokalny silnik reguł: zestaw warunków → zestaw akcji, uruchamiany
automatycznie na nowej poczcie przychodzącej (INBOX) podczas sync. Reguły
per-konto, zarządzane w sekcji Settings → Rules & Filters.

## Zablokowane decyzje zakresowe

1. **Wyzwalacz:** AUTO na przychodzącej, **tylko foldery typu inbox**, podczas
   `incremental_sync_folder` (poll/IDLE). Bez ręcznego „Uruchom reguły".
2. **Warunki (pola):** From (adres/nazwa), Subject, Recipient (To/Cc),
   Has-attachment. Pełne body NIEdostępne przy odbiorze (`body_state='none'`) —
   poza zakresem dopasowania.
3. **Akcje:** Apply label (lokalne), Mark as read (kolejka IMAP), Flag/star
   (kolejka IMAP), Snooze (lokalne). Move-to-folder ODROCZONE (brak prymitywu
   IMAP COPY+DELETE).
4. **Zasięg:** per-konto (reguła należy do konta, działa na jego przychodzącej).

## Decyzje przyjęte (nie pytane)

- Wiele warunków + wiele akcji na regułę; dopasowanie `all`/`any` (przełącznik
  per-reguła).
- Operatory tekstowe: `contains` / `is` (case-insensitive).
- Warunki/akcje serializowane jako **JSON** w kolumnach (wzorzec jak shortcuts
  overrides).
- Reguły uruchamiane w kolejności `position`; **wszystkie pasujące** aplikują
  swoje akcje (brak „stop processing" w v1).
- **Pusta lista warunków → reguła nigdy nie pasuje** (UI wymusza ≥1 warunek).
- **Snooze jako akcja = czas trwania w godzinach** (value, domyślnie 24);
  backend liczy `wake_at = now + hours*3600` (bez stref czasowych — inaczej niż
  frontowe presety „jutro 8:00" z 7c; akceptowalne).

## Architektura (thick Rust core)

- **`am-core`:** czyste typy + predykat dopasowania `rule_matches` (w pełni
  testowalny jednostkowo).
- **`am-storage::rules_repo`:** CRUD + (de)serializacja JSON.
- **`am-sync`:** silnik `apply_rules_to_messages` (potrzebuje `enqueue_flag`) +
  hook w `incremental_sync_folder`.
- **`am-app`:** komendy CRUD + bindings.
- **Frontend:** `queries.ts` hooki + `RulesSection`.
- Migracja **V10**.

## Model danych — `V10__rules.sql`

```sql
CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    match_type TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'any'
    conditions TEXT NOT NULL DEFAULT '[]',     -- JSON: [{field, op, value}]
    actions TEXT NOT NULL DEFAULT '[]',        -- JSON: [{kind, value}]
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rules_account ON rules(account_id, position);
```

## Typy + predykat (`am-core`, serde + specta::Type)

- `ConditionField` { From, Subject, Recipient, HasAttachment }.
- `ConditionOp` { Contains, Is }.
- `RuleCondition { field: ConditionField, op: ConditionOp, value: String }`.
- `RuleActionType` { Label, MarkRead, Flag, Snooze }.
- `RuleAction { kind: RuleActionType, value: String }` (Label→label_id;
  Snooze→hours; MarkRead/Flag→value ignorowane/puste).
- `MatchType` { All, Any }.
- `Rule { id, account_id, name, enabled, match_type: MatchType,
  conditions: Vec<RuleCondition>, actions: Vec<RuleAction>, position }`.
- `RuleInput { name, enabled, match_type, conditions, actions }` (do create/update).
- `RuleMessage { from_address, from_name: Option<String>, subject,
  recipients: Vec<String>, has_attachments }` — lekki widok do dopasowania.

**`rule_matches(rule: &Rule, msg: &RuleMessage) -> bool`:**
- Per warunek (case-insensitive):
  - From → `contains`/`is` vs `from_address` LUB `from_name`.
  - Subject → vs `subject`.
  - Recipient → `contains`/`is` dopasowane do KTÓREGOKOLWIEK z `recipients`
    (To+Cc).
  - HasAttachment → porównanie boolowskie z `value` ("true"/"false").
- `match_type == All` → wszystkie warunki true; `Any` → ≥1 true.
- **`conditions` puste → false.**

## CRUD (`am-storage::rules_repo`)

- `list_rules(db, account_id) -> Vec<Rule>` (ORDER BY position).
- `create_rule(db, account_id, input: &RuleInput) -> Rule` (position = liczba
  istniejących reguł konta; serializuje conditions/actions do JSON).
- `update_rule(db, id, input: &RuleInput) -> Rule` (pełna podmiana pól).
- `set_rule_enabled(db, id, enabled: bool)`.
- `delete_rule(db, id)`.
- (De)serializacja JSON ↔ `Vec<RuleCondition>`/`Vec<RuleAction>` (round-trip
  testowany).

## Silnik + hook (`am-sync`)

- `messages_repo::ids_by_uids(db, folder_id, uids: &[i64]) -> Vec<i64>` — nowy
  helper, by uzyskać ID nowo-wstawionych wiadomości bez zmiany sygnatury
  `insert_headers`.
- `apply_rules_to_messages(db, account_id, message_ids, now: i64) ->
  Result<(), SyncError>`:
  - ładuje **enabled** reguły konta (po `position`);
  - dla każdej wiadomości buduje `RuleMessage` (z bazy: from_address/from_name/
    subject/has_attachments + recipients z JSON `to_addresses`+`cc_addresses`);
  - dla każdej pasującej reguły (`rule_matches`) aplikuje akcje:
    - Label → `labels_repo::set_message_labels(db, label_id, &[id], true)`
      (parse value→i64; brak/niepoprawny label_id → pomiń);
    - MarkRead → `service::enqueue_flag(db, id, MessageFlag::Seen, true)`;
    - Flag → `service::enqueue_flag(db, id, MessageFlag::Flagged, true)`;
    - Snooze → `snooze_repo::snooze_messages(db, &[id], now + hours*3600)`
      (parse value→i64 godzin, fallback 24).
- **Hook** w `incremental_sync_folder`: **tylko gdy folder jest typu inbox**, po
  `insert_headers`+`assign_threads`, przed emisją `NewMessages`: pobierz ID przez
  `ids_by_uids`, wywołaj `apply_rules_to_messages(..., now)`. `now` z
  `SystemTime::now()` w serwisie; helper offsetu snooze testowalny z `now`.
- Pełny sync (`sync_all_folders`/`sync_folder`) NIE odpala reguł (jak
  `NewMessages` w 7b — brak „burzy" przy dodaniu konta/pierwszym sync).

## Komendy (`am-app`) + bindings

- `list_rules(account_id) -> Vec<Rule>`, `create_rule(account_id, input) ->
  Rule`, `update_rule(rule_id, input) -> Rule`, `set_rule_enabled(rule_id,
  enabled)`, `delete_rule(rule_id)`.
- Brak komendy „apply" (auto-only — silnik woła sync wewnętrznie).
- Rejestracja w `collect_commands!`, regen bindings (nowe typy Rule/
  RuleCondition/RuleAction/RuleInput/RuleMessage + enumy ConditionField/
  ConditionOp/RuleActionType/MatchType).

## Frontend

- `queries.ts`: `useRules(accountId)` + mutacje `useCreateRule`/`useUpdateRule`/
  `useSetRuleEnabled`/`useDeleteRule` (invalidują `["rules", accountId]`).
- **`RulesSection`** (mirror SignaturesSection co do selektora konta):
  - selektor konta → lista reguł konta (nazwa + toggle `enabled` + skrótowe
    podsumowanie + Edit/Delete);
  - **edytor** (inline/form): nazwa, match All/Any, **dynamiczne wiersze
    warunków** (select pola + select operatora + input wartości; dla
    HasAttachment wartość = select true/false; dodaj/usuń), **dynamiczne wiersze
    akcji** (select typu + kontrolka wartości: Label→picker etykiet [`useLabels`],
    Snooze→input godzin, MarkRead/Flag→bez wartości; dodaj/usuń), zapis/anuluj;
  - zapis odrzucany, gdy 0 warunków lub 0 akcji.
- Montaż w `SettingsOverlay` (`rules` → `<RulesSection/>`; placeholder „Coming
  soon" znika — pozostaje tylko Accounts).

## Testy

- **am-core:** `rule_matches` — każde pole (From adres+nazwa, Subject, Recipient
  any-of, HasAttachment), `contains` i `is`, `All` vs `Any`, case-insensitive,
  puste warunki → false; (de)serializacja JSON warunków/akcji. Snooze-offset
  helper (now + hours*3600, fallback 24).
- **am-storage:** `rules_repo` create/list(ordered)/update(replace)/set_enabled/
  delete; JSON round-trip; `ids_by_uids`.
- **am-sync:** `apply_rules_to_messages` na in-memory DB (label nadane; seen w
  kolejce; flagged w kolejce; snooze_wake_at ustawiony; reguła disabled →
  pominięta; brak dopasowania → bez zmian). Bez IMAP/sieci.
- **Frontend:** queries (mutacje + invalidacja); `RulesSection` (render listy,
  dodanie reguły, toggle enabled, dodaj/usuń wiersz warunku i akcji, walidacja
  ≥1 warunek i ≥1 akcja, delete).

## Test-infra (utrwalone konwencje)

- Nowe ikony lucide w kodzie → `src/test/lucide-stub.js`.
- `MessageListPane.test` ma kompletny literał `UiState` — 7e nie dotyka store
  UI, więc bez ryzyka; ale każda zmiana `UiState` wymaga rozszerzenia literału.
- `tsconfig include:["src"]` typechecks testy; `noUnusedLocals` ON → po zadaniu
  `npx vitest run` ORAZ `npm run build`. Po zmianach Rust/IPC: `npm run
  gen:bindings`.
- Tests używają `.toBeTruthy()`/`.toBeNull()`.
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`.

## Deferred / tech-debt

- Move-to-folder / archive (wymaga IMAP COPY+DELETE — etap 8+).
- „Stop processing further rules" / priorytety z przerwaniem.
- Reorder reguł w UI (na razie kolejność = kolejność tworzenia).
- Warunek po pełnej treści (body pobierane leniwie).
- Tłumienie powiadomienia 7b dla maili oznaczonych regułą jako przeczytane.
- Ręczne „Uruchom reguły na folderze" (batch na istniejących).
- Reguły dla folderów nie-inbox.
