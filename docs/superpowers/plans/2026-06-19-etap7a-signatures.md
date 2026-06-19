# Etap 7a Signatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pełna obsługa podpisów per-konto (CRUD + sekcja Settings + auto-wstawianie domyślnego podpisu w composerze).

**Architecture:** Podpisy są lokalnym zasobem per-konto na istniejącej tabeli `signatures` z V1 (zero migracji). Warstwa zapisu w `am-storage::signatures_repo`, cienkie komendy `am-app`, hooki react-query, sekcja `SignaturesSection` (TipTap StarterKit) i integracja z composerem (auto-insert przy świeżej kompozycji + picker). Wstawianie podpisu jest czysto frontendowe — `am-sync::build_prefill` pozostaje bez zmian.

**Tech Stack:** Rust (rusqlite + refinery), Tauri 2 + tauri-specta, React 19/TS, @tanstack/react-query v5, zustand, TipTap 3 (StarterKit), vitest + @testing-library/react + happy-dom.

## Global Constraints

- Wszystkie identyfikatory w kodzie po angielsku; ZERO komentarzy w kodzie źródłowym (dokumentacja w `docs/`).
- Conventional Commits 1.0.0; bez dopisywania siebie jako co-autora; push tylko na wyraźną prośbę.
- Nigdy `git add .` — stage wyłącznie jawnie wymienionych ścieżek (w repo jest gitignored sekret OAuth — nie wolno go zacommitować).
- Podpisy **per-konto** (kolumna `signatures.account_id`); **zero migracji** (schemat V1 wystarcza).
- Inwariant: konto z ≥1 podpisem ma **dokładnie jeden** domyślny (`is_default`). Egzekwowany w `signatures_repo`, nie constraintem SQL.
- Wstawianie podpisu realizowane we **froncie** (composer); `am-sync::build_prefill` BEZ ZMIAN.
- Edytor podpisu: **TipTap StarterKit** (bez rozszerzenia Image); ZERO nowej zależności.
- Auto-insert tylko przy świeżej kompozycji (`composer.draftId == null`); wznowiony draft nie wstawia ponownie.
- Pozycja auto-insertu: pusty akapit (kursor) → podpis → cytat (`prefill.html_body`) — podpis NAD cytatem.
- Test-infra: nowe ikony lucide MUSZĄ trafić do `src/test/lucide-stub.js` (inaczej vitest OOM); nowe komendy/hooki/pola store dodać do mocków w `src/app/AppShell.test.tsx`; projekt używa `.toBeTruthy()`/`.toBeNull()` (brak jest-dom); vitest NIE typuje — niekompletne literały TS wychodzą dopiero w `npm run build`/tsc.
- Node 24: przed komendami frontu `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`; testy `npx vitest run`, build `npm run build`, bindings `npm run gen:bindings`.

---

## File Structure

- `crates/am-storage/src/signatures_repo.rs` — **Modify**: dodaje `create_signature` / `update_signature` / `set_default_signature` / `delete_signature` + testy (Task 1).
- `crates/am-app/src/commands.rs` — **Modify**: 4 nowe komendy delegujące do repo (Task 2).
- `crates/am-app/src/lib.rs` — **Modify**: rejestracja komend w `collect_commands!` (Task 2).
- `src/ipc/bindings.ts` — **Regenerated** przez `npm run gen:bindings` (Task 2).
- `src/ipc/queries.ts` — **Modify**: `useSignatures` + 4 mutacje (Task 3).
- `src/ipc/queries.signatures.test.tsx` — **Create**: testy hooków (Task 3).
- `src/features/settings/SignaturesSection.tsx` — **Create**: sekcja Settings (Task 4).
- `src/features/settings/SignaturesSection.test.tsx` — **Create**: testy sekcji (Task 4).
- `src/features/settings/SettingsOverlay.tsx` — **Modify**: montaż sekcji pod id `signatures` (Task 4).
- `src/features/settings/Settings.css` — **Modify**: style sekcji podpisów (Task 4).
- `src/features/composer/Composer.tsx` — **Modify**: auto-insert + picker (Task 5).
- `src/features/composer/Composer.test.tsx` — **Modify**: mock TipTap (focus + `vi.hoisted` setContent) + nowe testy (Task 5).
- `src/app/AppShell.test.tsx` — **Modify**: dołożenie sygnatur do mocków, jeśli pełny przebieg vitest tego wymaga (Task 5 / Final Verification).

---

## Task 1: am-storage `signatures_repo` — warstwa zapisu

**Files:**
- Modify: `crates/am-storage/src/signatures_repo.rs`

**Interfaces:**
- Consumes: `am_core::signature::Signature { id: i64, name: String, html: String, is_default: bool }`; `crate::db::{Database, StorageError}`; `rusqlite::{params, OptionalExtension}`; istniejące `crate::accounts_repo::insert_account`, `am_core::account::{NewAccount, ProviderType}` (w testach).
- Produces:
  - `create_signature(db: &Database, account_id: i64, name: &str, html: &str, make_default: bool) -> Result<Signature, StorageError>`
  - `update_signature(db: &Database, id: i64, name: &str, html: &str) -> Result<(), StorageError>`
  - `set_default_signature(db: &Database, account_id: i64, id: i64) -> Result<(), StorageError>`
  - `delete_signature(db: &Database, id: i64) -> Result<(), StorageError>`
  - (istnieje) `list_signatures(db: &Database, account_id: i64) -> Result<Vec<Signature>, StorageError>`

- [ ] **Step 1: Napisz failing testy**

Dodaj na końcu istniejącego modułu `#[cfg(test)] mod tests` w `crates/am-storage/src/signatures_repo.rs` (moduł ma już helper `acct(db) -> i64`):

```rust
    #[test]
    fn create_first_signature_becomes_default() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let sig = create_signature(&db, account_id, "Work", "<p>BR</p>", false).unwrap();
        assert!(sig.is_default);
        assert_eq!(sig.name, "Work");
        let listed = list_signatures(&db, account_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_default);
    }

    #[test]
    fn create_with_make_default_unsets_previous_default() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", true).unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        let by_id = |id: i64| listed.iter().find(|s| s.id == id).unwrap().is_default;
        assert!(!by_id(first.id));
        assert!(by_id(second.id));
    }

    #[test]
    fn create_non_default_keeps_existing_default() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", false).unwrap();
        assert!(first.is_default);
        assert!(!second.is_default);
    }

    #[test]
    fn update_signature_changes_name_and_html() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let sig = create_signature(&db, account_id, "Work", "<p>old</p>", false).unwrap();
        update_signature(&db, sig.id, "Job", "<p>new</p>").unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        assert_eq!(listed[0].name, "Job");
        assert_eq!(listed[0].html, "<p>new</p>");
    }

    #[test]
    fn set_default_switches_between_signatures() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", false).unwrap();
        set_default_signature(&db, account_id, second.id).unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        let by_id = |id: i64| listed.iter().find(|s| s.id == id).unwrap().is_default;
        assert!(!by_id(first.id));
        assert!(by_id(second.id));
    }

    #[test]
    fn delete_default_promotes_min_id() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", true).unwrap();
        delete_signature(&db, second.id).unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, first.id);
        assert!(listed[0].is_default);
    }

    #[test]
    fn delete_non_default_keeps_default() {
        let db = Database::open_in_memory().unwrap();
        let account_id = acct(&db);
        let first = create_signature(&db, account_id, "Work", "<p>1</p>", false).unwrap();
        let second = create_signature(&db, account_id, "Casual", "<p>2</p>", false).unwrap();
        delete_signature(&db, second.id).unwrap();
        let listed = list_signatures(&db, account_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, first.id);
        assert!(listed[0].is_default);
    }

    #[test]
    fn signatures_are_isolated_per_account() {
        let db = Database::open_in_memory().unwrap();
        let a = acct(&db);
        let b = insert_account(
            &db,
            &NewAccount {
                email: "b@example.com".into(),
                display_name: "B".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap()
        .id;
        create_signature(&db, a, "A-sig", "<p>a</p>", true).unwrap();
        create_signature(&db, b, "B-sig", "<p>b</p>", true).unwrap();
        assert_eq!(list_signatures(&db, a).unwrap().len(), 1);
        assert_eq!(list_signatures(&db, b).unwrap().len(), 1);
        assert_eq!(list_signatures(&db, a).unwrap()[0].name, "A-sig");
    }
```

- [ ] **Step 2: Uruchom testy — muszą NIE przejść (brak funkcji)**

```bash
cargo test -p am-storage --lib signatures_repo
```
Expected: FAIL — `cannot find function create_signature`/`update_signature`/`set_default_signature`/`delete_signature`.

- [ ] **Step 3: Zaimplementuj funkcje**

Zmień nagłówek importów na górze pliku `crates/am-storage/src/signatures_repo.rs`:

```rust
use am_core::signature::Signature;
use rusqlite::{params, OptionalExtension};

use crate::db::{Database, StorageError};
```

Dodaj poniżej istniejącej `list_signatures` (a przed `#[cfg(test)]`):

```rust
pub fn create_signature(
    db: &Database,
    account_id: i64,
    name: &str,
    html: &str,
    make_default: bool,
) -> Result<Signature, StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let existing: i64 = tx.query_row(
        "SELECT COUNT(*) FROM signatures WHERE account_id = ?1",
        params![account_id],
        |r| r.get(0),
    )?;
    let is_default = make_default || existing == 0;
    if is_default {
        tx.execute(
            "UPDATE signatures SET is_default = 0 WHERE account_id = ?1",
            params![account_id],
        )?;
    }
    tx.execute(
        "INSERT INTO signatures (account_id, name, html, is_default) VALUES (?1, ?2, ?3, ?4)",
        params![account_id, name, html, is_default as i64],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(Signature {
        id,
        name: name.to_string(),
        html: html.to_string(),
        is_default,
    })
}

pub fn update_signature(
    db: &Database,
    id: i64,
    name: &str,
    html: &str,
) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE signatures SET name = ?2, html = ?3 WHERE id = ?1",
        params![id, name, html],
    )?;
    Ok(())
}

pub fn set_default_signature(
    db: &Database,
    account_id: i64,
    id: i64,
) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE signatures SET is_default = 0 WHERE account_id = ?1",
        params![account_id],
    )?;
    tx.execute(
        "UPDATE signatures SET is_default = 1 WHERE id = ?1 AND account_id = ?2",
        params![id, account_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn delete_signature(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let row: Option<(i64, i64)> = tx
        .query_row(
            "SELECT account_id, is_default FROM signatures WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    tx.execute("DELETE FROM signatures WHERE id = ?1", params![id])?;
    if let Some((account_id, is_default)) = row {
        if is_default != 0 {
            let next: Option<i64> = tx.query_row(
                "SELECT MIN(id) FROM signatures WHERE account_id = ?1",
                params![account_id],
                |r| r.get(0),
            )?;
            if let Some(next_id) = next {
                tx.execute(
                    "UPDATE signatures SET is_default = 1 WHERE id = ?1",
                    params![next_id],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}
```

- [ ] **Step 4: Uruchom testy — muszą przejść**

```bash
cargo test -p am-storage --lib signatures_repo
```
Expected: PASS — wszystkie testy `signatures_repo` zielone (istniejące 2 + 8 nowych).

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/signatures_repo.rs
git commit -m "feat(signatures): add create/update/set-default/delete repo functions"
```

---

## Task 2: am-app — komendy CRUD podpisów + bindings

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs`
- Regenerated: `src/ipc/bindings.ts`

**Interfaces:**
- Consumes: `am_storage::signatures_repo::{create_signature, update_signature, set_default_signature, delete_signature}` (Task 1); `am_core::signature::Signature` (już importowane w `commands.rs`); `AppState` (`state.db`).
- Produces (komendy tauri, w bindings jako camelCase):
  - `create_signature(account_id: i64, name: String, html: String, make_default: bool) -> Result<Signature, String>` → `commands.createSignature(accountId, name, html, makeDefault)`
  - `update_signature(id: i64, name: String, html: String) -> Result<(), String>` → `commands.updateSignature(id, name, html)`
  - `set_default_signature(account_id: i64, id: i64) -> Result<(), String>` → `commands.setDefaultSignature(accountId, id)`
  - `delete_signature(id: i64) -> Result<(), String>` → `commands.deleteSignature(id)`

Uwaga: komendy są cienkimi delegatorami; logika jest w pełni pokryta testami repo z Taska 1 (komendy biorą `tauri::State`, więc nie mają osobnego testu jednostkowego — zgodnie ze wzorcem reszty `commands.rs`). Bramka Taska to kompilacja + regeneracja i obecność komend w bindings.

- [ ] **Step 1: Dodaj komendy w `crates/am-app/src/commands.rs`**

Wstaw bezpośrednio po istniejącej `list_signatures` (zaraz za jej zamykającą klamrą):

```rust
#[tauri::command]
#[specta::specta]
pub fn create_signature(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    name: String,
    html: String,
    make_default: bool,
) -> Result<Signature, String> {
    signatures_repo::create_signature(&state.db, account_id, &name, &html, make_default)
        .map_err(|_| "Failed to create signature".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_signature(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    html: String,
) -> Result<(), String> {
    signatures_repo::update_signature(&state.db, id, &name, &html)
        .map_err(|_| "Failed to update signature".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_default_signature(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    id: i64,
) -> Result<(), String> {
    signatures_repo::set_default_signature(&state.db, account_id, id)
        .map_err(|_| "Failed to set default signature".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_signature(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    signatures_repo::delete_signature(&state.db, id)
        .map_err(|_| "Failed to delete signature".to_string())
}
```

- [ ] **Step 2: Zarejestruj komendy w `crates/am-app/src/lib.rs`**

W makrze `collect_commands![ ... ]` dodaj cztery wpisy bezpośrednio po `commands::list_signatures,`:

```rust
            commands::list_signatures,
            commands::create_signature,
            commands::update_signature,
            commands::set_default_signature,
            commands::delete_signature,
```

- [ ] **Step 3: Zbuduj — musi się skompilować**

```bash
cargo build -p abeonmail
```
Expected: kompilacja bez błędów.

- [ ] **Step 4: Zregeneruj bindings i potwierdź obecność komend**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm run gen:bindings
grep -E "createSignature|updateSignature|setDefaultSignature|deleteSignature" src/ipc/bindings.ts
```
Expected: każda z czterech komend występuje w `src/ipc/bindings.ts`.

- [ ] **Step 5: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(signatures): expose signature CRUD tauri commands"
```

---

## Task 3: queries.ts — hooki podpisów

**Files:**
- Modify: `src/ipc/queries.ts`
- Create: `src/ipc/queries.signatures.test.tsx`

**Interfaces:**
- Consumes: `commands.{listSignatures, createSignature, updateSignature, setDefaultSignature, deleteSignature}`; typ `Signature` z `./bindings`; `unwrap`, `useQuery`, `useMutation`, `useQueryClient`.
- Produces:
  - `useSignatures(accountId: number | null)` — query key `["signatures", accountId]`, enabled gdy `accountId != null`.
  - `useCreateSignature()` — vars `{ accountId, name, html, makeDefault }`.
  - `useUpdateSignature()` — vars `{ id, name, html, accountId }`.
  - `useSetDefaultSignature()` — vars `{ accountId, id }`.
  - `useDeleteSignature()` — vars `{ id, accountId }`.
  - Każda mutacja invaliduje `["signatures", accountId]`.

- [ ] **Step 1: Napisz failing test**

Utwórz `src/ipc/queries.signatures.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { commands } from "./bindings";
import {
  useSignatures,
  useCreateSignature,
  useUpdateSignature,
  useSetDefaultSignature,
  useDeleteSignature,
} from "./queries";

vi.mock("./bindings", () => ({
  commands: {
    listSignatures: vi.fn().mockResolvedValue({
      status: "ok",
      data: [{ id: 1, name: "Work", html: "<p>BR</p>", is_default: true }],
    }),
    createSignature: vi.fn().mockResolvedValue({
      status: "ok",
      data: { id: 2, name: "Casual", html: "<p>Cheers</p>", is_default: false },
    }),
    updateSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    setDefaultSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    deleteSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("signature hooks", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("useSignatures fetches for the account", async () => {
    const { result } = renderHook(() => useSignatures(7), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(commands.listSignatures).toHaveBeenCalledWith(7);
  });

  it("useSignatures is disabled when account is null", async () => {
    const { result } = renderHook(() => useSignatures(null), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(commands.listSignatures).not.toHaveBeenCalled();
  });

  it("useCreateSignature calls command", async () => {
    const { result } = renderHook(() => useCreateSignature(), { wrapper: wrapper() });
    result.current.mutate({ accountId: 7, name: "Casual", html: "<p>x</p>", makeDefault: false });
    await waitFor(() =>
      expect(commands.createSignature).toHaveBeenCalledWith(7, "Casual", "<p>x</p>", false),
    );
  });

  it("useUpdateSignature calls command", async () => {
    const { result } = renderHook(() => useUpdateSignature(), { wrapper: wrapper() });
    result.current.mutate({ id: 3, name: "Job", html: "<p>y</p>", accountId: 7 });
    await waitFor(() =>
      expect(commands.updateSignature).toHaveBeenCalledWith(3, "Job", "<p>y</p>"),
    );
  });

  it("useSetDefaultSignature calls command", async () => {
    const { result } = renderHook(() => useSetDefaultSignature(), { wrapper: wrapper() });
    result.current.mutate({ accountId: 7, id: 3 });
    await waitFor(() => expect(commands.setDefaultSignature).toHaveBeenCalledWith(7, 3));
  });

  it("useDeleteSignature calls command", async () => {
    const { result } = renderHook(() => useDeleteSignature(), { wrapper: wrapper() });
    result.current.mutate({ id: 3, accountId: 7 });
    await waitFor(() => expect(commands.deleteSignature).toHaveBeenCalledWith(3));
  });
});
```

- [ ] **Step 2: Uruchom test — musi NIE przejść**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/ipc/queries.signatures.test.tsx
```
Expected: FAIL — `useSignatures`/mutacje nie istnieją (import error).

- [ ] **Step 3: Dodaj hooki**

W `src/ipc/queries.ts` rozszerz import typów (dodaj `Signature`):

```ts
import type { Account, Endpoints, Label, MessageFlag, OutgoingMessage, Signature, SmartFolderKind, SmartMessageRow } from "./bindings";
```

Dodaj na końcu pliku:

```ts
export function useSignatures(accountId: number | null) {
  return useQuery<Signature[]>({
    queryKey: ["signatures", accountId],
    queryFn: () => commands.listSignatures(accountId!).then(unwrap),
    enabled: accountId != null,
  });
}

export function useCreateSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      accountId,
      name,
      html,
      makeDefault,
    }: {
      accountId: number;
      name: string;
      html: string;
      makeDefault: boolean;
    }) => commands.createSignature(accountId, name, html, makeDefault).then(unwrap),
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ["signatures", accountId] });
    },
  });
}

export function useUpdateSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      name,
      html,
    }: {
      id: number;
      name: string;
      html: string;
      accountId: number;
    }) => commands.updateSignature(id, name, html).then(unwrap),
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ["signatures", accountId] });
    },
  });
}

export function useSetDefaultSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, id }: { accountId: number; id: number }) =>
      commands.setDefaultSignature(accountId, id).then(unwrap),
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ["signatures", accountId] });
    },
  });
}

export function useDeleteSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number; accountId: number }) =>
      commands.deleteSignature(id).then(unwrap),
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ["signatures", accountId] });
    },
  });
}
```

- [ ] **Step 4: Uruchom test — musi przejść**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/ipc/queries.signatures.test.tsx
```
Expected: PASS — 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/queries.ts src/ipc/queries.signatures.test.tsx
git commit -m "feat(signatures): add signature query hooks"
```

---

## Task 4: SignaturesSection + montaż w SettingsOverlay

**Files:**
- Create: `src/features/settings/SignaturesSection.tsx`
- Create: `src/features/settings/SignaturesSection.test.tsx`
- Modify: `src/features/settings/SettingsOverlay.tsx`
- Modify: `src/features/settings/Settings.css`

**Interfaces:**
- Consumes: `useAccounts`, `useSignatures`, `useCreateSignature`, `useUpdateSignature`, `useSetDefaultSignature`, `useDeleteSignature` (Task 3); `useEditor`/`EditorContent` (`@tiptap/react`); `StarterKit` (`@tiptap/starter-kit`); `Trash2` (`lucide-react`).
- Produces: `SignaturesSection` (named export) montowany w `SettingsOverlay` pod id `signatures`.

`Trash2` jest już w `src/test/lucide-stub.js` (dodane w 6d) — bez zmian w stubie.

- [ ] **Step 1: Napisz failing test**

Utwórz `src/features/settings/SignaturesSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SignaturesSection } from "./SignaturesSection";
import { commands } from "../../ipc/bindings";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listAccounts: vi.fn().mockResolvedValue({
      status: "ok",
      data: [
        { id: 7, email: "me@example.com", display_name: "Me", provider_type: "imap_password", color: null, position: 0, requires_reauth: false },
        { id: 8, email: "other@example.com", display_name: "Other", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
      ],
    }),
    listSignatures: vi.fn().mockResolvedValue({
      status: "ok",
      data: [
        { id: 1, name: "Work", html: "<p>BR</p>", is_default: true },
        { id: 2, name: "Casual", html: "<p>Cheers</p>", is_default: false },
      ],
    }),
    createSignature: vi.fn().mockResolvedValue({ status: "ok", data: { id: 3, name: "New", html: "<p></p>", is_default: false } }),
    updateSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    setDefaultSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    deleteSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

vi.mock("@tiptap/react", () => {
  const editorInstance = {
    getHTML: () => "<p>edited</p>",
    commands: { setContent: vi.fn(), focus: vi.fn() },
    destroy: vi.fn(),
  };
  return {
    useEditor: () => editorInstance,
    EditorContent: () => <div data-testid="signature-editor" />,
  };
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("SignaturesSection", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("lists signatures for the first account", async () => {
    const { getByText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    expect(getByText("Casual")).toBeTruthy();
  });

  it("creates a new signature", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByText("New signature"));
    fireEvent.change(getByLabelText("Signature name"), { target: { value: "Holiday" } });
    fireEvent.click(getByText("Save signature"));
    await waitFor(() =>
      expect(commands.createSignature).toHaveBeenCalledWith(7, "Holiday", "<p>edited</p>", false),
    );
  });

  it("sets a non-default signature as default", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByLabelText("Set Casual as default"));
    await waitFor(() => expect(commands.setDefaultSignature).toHaveBeenCalledWith(7, 2));
  });

  it("deletes a signature", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByLabelText("Delete signature Casual"));
    await waitFor(() => expect(commands.deleteSignature).toHaveBeenCalledWith(2));
  });

  it("reloads signatures when the account changes", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.change(getByLabelText("Signatures account"), { target: { value: "8" } });
    await waitFor(() => expect(commands.listSignatures).toHaveBeenCalledWith(8));
  });
});
```

- [ ] **Step 2: Uruchom test — musi NIE przejść**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/features/settings/SignaturesSection.test.tsx
```
Expected: FAIL — `SignaturesSection` nie istnieje.

- [ ] **Step 3: Zaimplementuj `SignaturesSection.tsx`**

Utwórz `src/features/settings/SignaturesSection.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Trash2 } from "lucide-react";
import {
  useAccounts,
  useSignatures,
  useCreateSignature,
  useUpdateSignature,
  useSetDefaultSignature,
  useDeleteSignature,
} from "../../ipc/queries";

export function SignaturesSection() {
  const { data: accounts = [] } = useAccounts();
  const [chosenAccountId, setChosenAccountId] = useState<number | null>(null);
  const accountId = chosenAccountId ?? accounts[0]?.id ?? null;

  const { data: signatures = [] } = useSignatures(accountId);
  const createSignature = useCreateSignature();
  const updateSignature = useUpdateSignature();
  const setDefaultSignature = useSetDefaultSignature();
  const deleteSignature = useDeleteSignature();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const editor = useEditor({ extensions: [StarterKit], content: "" });

  useEffect(() => {
    setSelectedId(null);
    setName("");
    editor?.commands.setContent("<p></p>");
  }, [accountId, editor]);

  function selectSignature(id: number, sigName: string, html: string) {
    setSelectedId(id);
    setName(sigName);
    editor?.commands.setContent(html);
  }

  function startNew() {
    setSelectedId(null);
    setName("");
    editor?.commands.setContent("<p></p>");
  }

  function save() {
    if (accountId == null) return;
    const html = editor?.getHTML() ?? "<p></p>";
    const trimmed = name.trim() || "Signature";
    if (selectedId == null) {
      createSignature.mutate({ accountId, name: trimmed, html, makeDefault: signatures.length === 0 });
    } else {
      updateSignature.mutate({ id: selectedId, name: trimmed, html, accountId });
    }
  }

  function remove(id: number) {
    if (accountId == null) return;
    deleteSignature.mutate({ id, accountId });
    if (selectedId === id) startNew();
  }

  return (
    <div className="settings-section">
      <label className="signatures-settings__account">
        Account
        <select
          aria-label="Signatures account"
          value={accountId ?? ""}
          onChange={(e) => setChosenAccountId(Number(e.target.value))}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </label>

      <ul className="signatures-settings__list">
        {signatures.map((sig) => (
          <li key={sig.id} className="signatures-settings__row">
            <button
              type="button"
              className="signatures-settings__name"
              onClick={() => selectSignature(sig.id, sig.name, sig.html)}
            >
              {sig.name}
            </button>
            <label className="signatures-settings__default">
              <input
                type="radio"
                name="default-signature"
                aria-label={`Set ${sig.name} as default`}
                checked={sig.is_default}
                onChange={() => setDefaultSignature.mutate({ accountId: accountId!, id: sig.id })}
              />
              Default
            </label>
            <button
              type="button"
              aria-label={`Delete signature ${sig.name}`}
              onClick={() => remove(sig.id)}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>

      <div className="signatures-settings__editor">
        <input
          type="text"
          aria-label="Signature name"
          placeholder="Signature name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <EditorContent editor={editor} className="signatures-settings__body" />
        <div className="signatures-settings__actions">
          <button type="button" onClick={startNew}>
            New signature
          </button>
          <button type="button" onClick={save}>
            Save signature
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Zamontuj sekcję w `SettingsOverlay.tsx`**

W `src/features/settings/SettingsOverlay.tsx` dodaj import:

```tsx
import { SignaturesSection } from "./SignaturesSection";
```

W łańcuchu renderującym sekcje zamień fragment tak, by `signatures` renderowało `SignaturesSection` (przed gałęzią `Coming soon`):

```tsx
          {active === "appearance" ? (
            <AppearanceSection />
          ) : active === "labels" ? (
            <LabelsSection />
          ) : active === "signatures" ? (
            <SignaturesSection />
          ) : active === "shortcuts" ? (
            <ShortcutsSection />
          ) : (
            <div className="settings-placeholder">Coming soon</div>
          )}
```

- [ ] **Step 5: Dodaj style w `Settings.css`**

Dopisz na końcu `src/features/settings/Settings.css`:

```css
.signatures-settings__account {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--text-subject);
}

.signatures-settings__list {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.signatures-settings__row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.signatures-settings__name {
  flex: 1;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-subject);
  padding: 6px 8px;
  border-radius: 6px;
}

.signatures-settings__name:hover {
  background: var(--selection-bg);
}

.signatures-settings__default {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-preview);
}

.signatures-settings__editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.signatures-settings__body {
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  min-height: 120px;
  padding: 8px;
}

.signatures-settings__actions {
  display: flex;
  gap: 8px;
}
```

- [ ] **Step 6: Uruchom testy — muszą przejść**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/features/settings/SignaturesSection.test.tsx src/features/settings/SettingsOverlay.test.tsx
```
Expected: PASS — `SignaturesSection` 5/5; `SettingsOverlay` bez regresji.

- [ ] **Step 7: Commit**

```bash
git add src/features/settings/SignaturesSection.tsx src/features/settings/SignaturesSection.test.tsx src/features/settings/SettingsOverlay.tsx src/features/settings/Settings.css
git commit -m "feat(signatures): add Signatures settings section"
```

---

## Task 5: Composer — auto-insert domyślnego podpisu + picker

**Files:**
- Modify: `src/features/composer/Composer.tsx`
- Modify: `src/features/composer/Composer.test.tsx`

**Interfaces:**
- Consumes: `commands.listSignatures`; typ `Signature` z `../../ipc/bindings`; `useUiStore` (`composer.draftId`, `composer.prefill`); istniejący `editor` (TipTap), `accountId`, `scheduleAutosave`.
- Produces: zachowanie composera — auto-insert domyślnego podpisu konta przy `composer.draftId == null` (nad cytatem) + picker `<select aria-label="Insert signature">` (gdy konto ma ≥1 podpis), wstawiający wybrany podpis w pozycji kursora. Usuwa starą `handleInsertSignature` i przycisk „Insert signature".

- [ ] **Step 1: Zaktualizuj mock TipTap i napisz failing testy w `Composer.test.tsx`**

Na górze `src/features/composer/Composer.test.tsx`, PRZED blokiem `vi.mock("@tiptap/react", ...)`, dodaj hoisted spy:

```tsx
const { mockSetContent } = vi.hoisted(() => ({ mockSetContent: vi.fn() }));
```

W mocku `@tiptap/react` zamień linię `commands: { setContent: vi.fn() },` na:

```tsx
    commands: { setContent: mockSetContent, focus: vi.fn() },
```

Dodaj helper pełnego prefill oraz nowe testy (wewnątrz `describe("Composer", ...)`), korzystając z istniejącego `Wrapper`/`useUiStore`:

```tsx
  const emptyPrefill = {
    from_address: "",
    from_name: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    text_body: "",
    html_body: null,
    in_reply_to: null,
    references: [],
    attachments: [],
  };

  it("auto-inserts the default signature above the quote on a fresh reply", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 1, name: "Default", html: "<p>SIG-MARK</p>", is_default: true }],
    });
    useUiStore.setState({
      composer: {
        open: true,
        draftId: null,
        prefill: { ...emptyPrefill, html_body: "<blockquote>QUOTED</blockquote>" },
      },
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    await waitFor(() => {
      const call = mockSetContent.mock.calls.find((c) => String(c[0]).includes("SIG-MARK"));
      expect(call).toBeTruthy();
    });
    const call = mockSetContent.mock.calls.find((c) => String(c[0]).includes("SIG-MARK"));
    const content = String(call?.[0]);
    expect(content).toContain("QUOTED");
    expect(content.indexOf("SIG-MARK")).toBeLessThan(content.indexOf("QUOTED"));
  });

  it("does not auto-insert a signature when reopening an existing draft", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 1, name: "Default", html: "<p>SIG-MARK</p>", is_default: true }],
    });
    useUiStore.setState({
      composer: {
        open: true,
        draftId: 42,
        prefill: { ...emptyPrefill, html_body: "<p>existing draft body</p>" },
      },
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sigCall = mockSetContent.mock.calls.find((c) => String(c[0]).includes("SIG-MARK"));
    expect(sigCall).toBeUndefined();
  });

  it("shows a signature picker when the account has signatures", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [
        { id: 1, name: "Default", html: "<p>BR</p>", is_default: true },
        { id: 2, name: "Casual", html: "<p>Cheers</p>", is_default: false },
      ],
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    const picker = await screen.findByLabelText("Insert signature");
    expect(within(picker).getByText("Casual")).toBeTruthy();
  });
```

Dodaj `within` do istniejącego importu z `@testing-library/react` (linia obecnie: `import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";` → dopisz `within`).

- [ ] **Step 2: Uruchom testy — muszą NIE przejść**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/features/composer/Composer.test.tsx
```
Expected: FAIL — picker nie istnieje; auto-insert nie woła `setContent` z podpisem.

- [ ] **Step 3: Zaimplementuj auto-insert + picker w `Composer.tsx`**

Rozszerz import typów (dodaj `Signature`):

```tsx
import type { OutgoingAttachment, Signature } from "../../ipc/bindings";
```

Dodaj stan i efekty bezpośrednio po istniejącym efekcie ustawiającym treść z prefill (`useEffect(() => { if (prefill?.html_body && editor) { editor.commands.setContent(prefill.html_body); } }, [prefill?.html_body, editor]);`):

```tsx
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const signatureInsertedRef = useRef(false);

  useEffect(() => {
    if (accountId == null) return;
    let cancelled = false;
    commands.listSignatures(accountId).then((result) => {
      if (!cancelled && result.status === "ok") setSignatures(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (signatureInsertedRef.current) return;
    if (!editor) return;
    if (composer.draftId != null) {
      signatureInsertedRef.current = true;
      return;
    }
    if (signatures.length === 0) return;
    signatureInsertedRef.current = true;
    const sig = signatures.find((s) => s.is_default);
    if (!sig) return;
    const quote = prefill?.html_body ?? "";
    editor.commands.setContent(`<p></p>${sig.html}${quote}`);
    editor.commands.focus("start");
  }, [editor, signatures, composer.draftId, prefill?.html_body]);

  function insertSignature(html: string) {
    if (!editor) return;
    editor.chain().focus().insertContent(html).run();
    scheduleAutosave();
  }
```

Usuń całą istniejącą funkcję `handleInsertSignature` (od `async function handleInsertSignature() {` do jej zamykającej klamry).

W stopce composera zamień przycisk:

```tsx
          <button type="button" className="btn-signature" onClick={handleInsertSignature}>
            Insert signature
          </button>
```

na picker:

```tsx
          {signatures.length > 0 && (
            <select
              className="btn-signature"
              aria-label="Insert signature"
              value=""
              onChange={(e) => {
                const sig = signatures.find((s) => String(s.id) === e.target.value);
                if (sig) insertSignature(sig.html);
                e.currentTarget.value = "";
              }}
            >
              <option value="">Insert signature…</option>
              {signatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
```

- [ ] **Step 4: Uruchom testy composera — muszą przejść**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run src/features/composer/Composer.test.tsx
```
Expected: PASS — istniejące testy + 3 nowe.

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/Composer.tsx src/features/composer/Composer.test.tsx
git commit -m "feat(signatures): auto-insert default signature and picker in composer"
```

---

## Final Verification

Po ukończeniu wszystkich zadań uruchom pełne bramki na gałęzi.

- [ ] **Step 1: Pełny zestaw testów Rust**

```bash
cargo test --workspace --lib --bins
```
Expected: PASS — bez regresji (am-storage rośnie o 8 testów `signatures_repo`).

- [ ] **Step 2: Pełny zestaw testów frontu**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run
```
Expected: PASS — w tym nowe pliki testów. Jeśli `src/app/AppShell.test.tsx` zgłosi brak komendy/hooka podpisów w swoich mockach `../ipc/queries` lub `../ipc/bindings`, dołóż tam stuby (`useSignatures`/`createSignature`/`updateSignature`/`setDefaultSignature`/`deleteSignature` + `listSignatures` w bindings) i ponów. (Regresja cross-suite widoczna tylko w pełnym przebiegu.) Znana, niezależna flaka: `src/shared/hooks/useDebouncedValue.test.ts` (timing) — nie jest regresją 7a.

- [ ] **Step 3: Build produkcyjny (typecheck)**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm run build
```
Expected: PASS — tsc + vite bez błędów (łapie niekompletne literały TS, których vitest nie wykrywa).

- [ ] **Step 4: Jeśli Step 2 wymagał zmian w AppShell.test — commit**

```bash
git add src/app/AppShell.test.tsx
git commit -m "test(signatures): add signature mocks to AppShell suite"
```
