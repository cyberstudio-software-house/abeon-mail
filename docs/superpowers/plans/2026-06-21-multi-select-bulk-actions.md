# Multi-select Bulk Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pozwolić zaznaczać wiele wiadomości myszą (shift / ctrl-klik) i wykonywać na nich akcje masowe z panelu w prawym oknie (przeczytane/nieprzeczytane, archiwum, usuń, przenieś do folderu, etykieta, drzemka).

**Architecture:** Jedno źródło prawdy zaznaczenia w zustand (`selectedRowIds` + kotwica), modyfikatory myszy mapowane na akcje store, próg `>= 2` przełącza prawy panel na `BulkActionPanel`. Akcje operują na `message_id[]`; w trybie wątkowym `thread_id` są leniwie rozwijane przez nową komendę backendu. „Przenieś do folderu" to nowa ścieżka w istniejącym mechanizmie kolejki `move_message`.

**Tech Stack:** React 19, zustand 5, @tanstack/react-query 5, Tauri 2 + specta, Rust (am-sync / am-app / am-storage), vitest + @testing-library/react, cargo test.

## Global Constraints

- Wszystkie identyfikatory w kodzie po angielsku; bez komentarzy w kodzie (reguły użytkownika z CLAUDE.md).
- Commity w stylu Conventional Commits; bez dopisywania współautora; bez `git push`.
- Pracujemy na gałęzi `feat/multi-select-bulk-actions` (od `main`).
- Trzymać się modelu z `docs/superpowers/specs/2026-06-21-multi-select-bulk-actions-design.md` — bez zmiany podejścia.
- Migracja stanu zaznaczenia jest **addytywna**: nowe pola dodajemy obok starych, a stary mechanizm (`selectionActive`, `selectedMessageIds`, `toggleSelectionMode`, `toggleMessageSelected`, `selectAll`) usuwamy dopiero w ostatnim zadaniu — dzięki temu build (`tsc`) i testy są zielone po każdym zadaniu.
- Frontend test: `npm test`. Rust test: `cargo test -p am-sync` (i `cargo build` dla całości). Bindingi: `npm run gen:bindings`.

---

### Task 1: Backend — `enqueue_move_to_folder` + obsługa celu `"folder"` w drenażu kolejki

**Files:**
- Modify: `crates/am-sync/src/service.rs` (dodanie funkcji + zmiana `drain_one_move`)
- Test: `crates/am-sync/src/service.rs` (moduł `#[cfg(test)] mod move_tests`)

**Interfaces:**
- Produces: `pub fn enqueue_move_to_folder(db: &Database, message_id: i64, target_folder_id: i64, now: i64) -> Result<(), SyncError>`
- Consumes: istniejące `messages_repo::locate`, `messages_repo::set_deleted`, `folders_repo::{get_sync_markers, get_folder, recount_unread}`, `threads_repo::recompute`, `queue_repo::enqueue_at`, stała `UNDO_GRACE_SECS`.

- [ ] **Step 1: Napisz failing test** (dopisz na końcu modułu `mod move_tests`, przed zamykającym `}` modułu)

```rust
    #[test]
    fn enqueue_move_to_folder_hides_and_writes_target_folder_payload() {
        let (db, account_id, mid) = setup();
        let dest = folders_repo::upsert_folder(&db, account_id, "Work", "Work", FolderType::Custom).unwrap();
        enqueue_move_to_folder(&db, mid, dest.id, 1000).unwrap();

        let inbox = folders_repo::find_by_type(&db, account_id, FolderType::Inbox).unwrap().unwrap();
        assert!(messages_repo::list_by_folder(&db, inbox.id, 10, 0, i64::MAX).unwrap().is_empty());

        let due = queue_repo::list_due(&db, account_id, 1000 + UNDO_GRACE_SECS).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].op_type, "move_message");
        let payload: serde_json::Value = serde_json::from_str(&due[0].payload).unwrap();
        assert_eq!(payload["target_type"], "folder");
        assert_eq!(payload["target_folder_id"], dest.id);
    }
```

- [ ] **Step 2: Uruchom test — ma się nie skompilować / failować**

Run: `cargo test -p am-sync enqueue_move_to_folder_hides_and_writes_target_folder_payload`
Expected: FAIL — `cannot find function enqueue_move_to_folder`.

- [ ] **Step 3: Dodaj funkcję `enqueue_move_to_folder`** (w `service.rs`, tuż pod `enqueue_move`, ok. linii 835)

```rust
pub fn enqueue_move_to_folder(db: &Database, message_id: i64, target_folder_id: i64, now: i64) -> Result<(), SyncError> {
    let loc = messages_repo::locate(db, message_id)?;
    let markers = folders_repo::get_sync_markers(db, loc.folder_id)?;
    let uidvalidity = markers.uidvalidity.unwrap_or(0);

    messages_repo::set_deleted(db, message_id, true)?;
    folders_repo::recount_unread(db, loc.folder_id)?;
    if let Some(thread_id) = loc.thread_id {
        threads_repo::recompute(db, thread_id)?;
    }

    let payload = serde_json::json!({
        "message_id": message_id,
        "folder_id": loc.folder_id,
        "uid": loc.uid,
        "uidvalidity": uidvalidity,
        "target_type": "folder",
        "target_folder_id": target_folder_id,
    })
    .to_string();
    queue_repo::enqueue_at(db, loc.account_id, "move_message", &payload, now + UNDO_GRACE_SECS)?;
    Ok(())
}
```

- [ ] **Step 4: Uruchom test — ma przejść**

Run: `cargo test -p am-sync enqueue_move_to_folder_hides_and_writes_target_folder_payload`
Expected: PASS.

- [ ] **Step 5: Zaktualizuj `drain_one_move`, by obsługiwał `target_type:"folder"`**

Zastąp w `drain_one_move` (linie ~996–1021) blok od `let target = match parsed["target_type"]...` do końca wyznaczania `dst` poniższym kodem. Wynik: `src` i walidacja `uidvalidity` bez zmian; rozwiązanie `dst` zależne od `target_type`.

```rust
    let target_type = parsed["target_type"].as_str().unwrap_or("");

    let src = match folders_repo::get_folder(db, folder_id) {
        Ok(f) => f,
        Err(_) => return retry_or_drop(db, op, now),
    };
    match folders_repo::get_sync_markers(db, folder_id).ok().and_then(|m| m.uidvalidity) {
        Some(v) if v == payload_validity => {}
        Some(_) => return mark_move_failed(db, op, "source folder uidvalidity changed"),
        None => return retry_or_drop(db, op, now),
    }

    let dst = match target_type {
        "archive" | "trash" => {
            let target = if target_type == "archive" { MoveTarget::Archive } else { MoveTarget::Trash };
            match folders_repo::find_by_type(db, account_id, target.folder_type())? {
                Some(f) => f,
                None => {
                    let name = target.default_folder_name();
                    if session.create_folder(name).await.is_err() {
                        return retry_or_drop(db, op, now);
                    }
                    folders_repo::upsert_folder(db, account_id, name, name, target.folder_type())?
                }
            }
        }
        "folder" => {
            let target_folder_id = parsed["target_folder_id"].as_i64().unwrap_or(0);
            match folders_repo::get_folder(db, target_folder_id) {
                Ok(f) => f,
                Err(_) => return mark_move_failed(db, op, "unknown target folder"),
            }
        }
        _ => return mark_move_failed(db, op, "unknown move target"),
    };
```

> Uwaga: usuń stary, wcześniejszy blok `let target = match parsed["target_type"]...` (early-return na nieznanym targecie) — walidacja jest teraz w `match target_type` przy wyznaczaniu `dst`. Pozostała część funkcji (`session.move_uid(...)`) bez zmian.

- [ ] **Step 6: Uruchom pełne testy am-sync + build**

Run: `cargo test -p am-sync && cargo build`
Expected: PASS, brak błędów kompilacji (m.in. nadal przechodzą `enqueue_move_hides_and_schedules_delayed_op`, `undo_move_unhides_and_cancels_pending_op`).

- [ ] **Step 7: Commit**

```bash
git add crates/am-sync/src/service.rs
git commit -m "feat(sync): enqueue_move_to_folder and folder move drain path"
```

---

### Task 2: Backend — komendy `move_messages` + `message_ids_for_threads`, rejestracja i regeneracja bindingów

**Files:**
- Modify: `crates/am-app/src/commands.rs` (dwie nowe komendy, przy `delete_messages`/`list_thread_messages`)
- Modify: `crates/am-app/src/lib.rs` (rejestracja w `collect_commands!`)
- Regenerate: `src/ipc/bindings.ts` (przez `npm run gen:bindings`)

**Interfaces:**
- Produces (binding TS): `commands.moveMessages(messageIds: number[], targetFolderId: number) => Result<null, string>`, `commands.messageIdsForThreads(threadIds: number[]) => Result<number[], string>`
- Consumes: `am_sync::service::{enqueue_move_to_folder, now_secs}`, `messages_repo::list_by_thread`.

- [ ] **Step 1: Dodaj komendy w `commands.rs`** (po `delete_messages`, ok. linii 434)

```rust
#[tauri::command]
#[specta::specta]
pub fn move_messages(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
    target_folder_id: i64,
) -> Result<(), String> {
    let now = am_sync::service::now_secs();
    for id in message_ids {
        am_sync::service::enqueue_move_to_folder(&state.db, id, target_folder_id, now)
            .map_err(|_| "Failed to move".to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn message_ids_for_threads(
    state: tauri::State<'_, AppState>,
    thread_ids: Vec<i64>,
) -> Result<Vec<i64>, String> {
    let mut out = Vec::new();
    for tid in thread_ids {
        let msgs = messages_repo::list_by_thread(&state.db, tid).map_err(|e| e.to_string())?;
        out.extend(msgs.into_iter().map(|m| m.id));
    }
    Ok(out)
}
```

- [ ] **Step 2: Zarejestruj komendy w `lib.rs`** (w `collect_commands![...]`, po `commands::undo_move,`)

```rust
            commands::move_messages,
            commands::message_ids_for_threads,
```

- [ ] **Step 3: Zbuduj backend (weryfikacja kompilacji komend)**

Run: `cargo build`
Expected: PASS.

- [ ] **Step 4: Zregeneruj bindingi**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` zawiera `moveMessages` i `messageIdsForThreads`.

Weryfikacja: `grep -n "moveMessages\|messageIdsForThreads" src/ipc/bindings.ts` → 2 trafienia.

- [ ] **Step 5: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): move_messages and message_ids_for_threads commands"
```

---

### Task 3: Store — jednolity model zaznaczenia (addytywnie)

**Files:**
- Modify: `src/app/store.ts`
- Test: `src/app/store.selection.test.ts` (Create)

**Interfaces:**
- Produces (na `UiState`): `selectedRowIds: number[]`, `selectionAnchorId: number | null`, `rowAccounts: Record<number, number>`, `selectRow(id: number): void`, `toggleRow(id: number): void`, `selectRangeTo(id: number): void`; zmienione `setListContext(ids: number[], mode: "thread" | "message", accounts?: Record<number, number>): void`, `clearSelection(): void`, `setSelectedThreadId`, `setSelectedMessageId`.
- Consumes: istniejące `visibleMessageIds`, `selectMode`.

- [ ] **Step 1: Napisz failing test** — `src/app/store.selection.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./store";

beforeEach(() => {
  useUiStore.setState({
    selectMode: "thread",
    visibleMessageIds: [1, 2, 3, 4, 5],
    selectedThreadId: null,
    selectedMessageId: null,
    selectedRowIds: [],
    selectionAnchorId: null,
    rowAccounts: {},
  });
});

describe("selection model", () => {
  it("selectRow selects one row, sets anchor and opens thread", () => {
    useUiStore.getState().selectRow(3);
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([3]);
    expect(s.selectionAnchorId).toBe(3);
    expect(s.selectedThreadId).toBe(3);
  });

  it("toggleRow adds and removes rows", () => {
    useUiStore.getState().selectRow(2);
    useUiStore.getState().toggleRow(4);
    expect(useUiStore.getState().selectedRowIds).toEqual([2, 4]);
    useUiStore.getState().toggleRow(2);
    expect(useUiStore.getState().selectedRowIds).toEqual([4]);
  });

  it("toggleRow down to one reopens that row", () => {
    useUiStore.setState({ selectedRowIds: [2, 4], selectedThreadId: 2 });
    useUiStore.getState().toggleRow(2);
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([4]);
    expect(s.selectedThreadId).toBe(4);
  });

  it("selectRangeTo selects inclusive range from anchor", () => {
    useUiStore.getState().selectRow(2);
    useUiStore.getState().selectRangeTo(4);
    expect(useUiStore.getState().selectedRowIds).toEqual([2, 3, 4]);
  });

  it("selectRangeTo works upward (clicked before anchor)", () => {
    useUiStore.getState().selectRow(4);
    useUiStore.getState().selectRangeTo(2);
    expect(useUiStore.getState().selectedRowIds).toEqual([2, 3, 4]);
  });

  it("clearSelection empties selection and anchor", () => {
    useUiStore.getState().selectRow(2);
    useUiStore.getState().clearSelection();
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([]);
    expect(s.selectionAnchorId).toBeNull();
  });

  it("setListContext stores rowAccounts", () => {
    useUiStore.getState().setListContext([1, 2], "message", { 1: 10, 2: 20 });
    expect(useUiStore.getState().rowAccounts).toEqual({ 1: 10, 2: 20 });
  });
});
```

- [ ] **Step 2: Uruchom test — ma failować**

Run: `npm test -- store.selection`
Expected: FAIL — `selectRow is not a function` / brak pól.

- [ ] **Step 3: Dodaj pola do typu `UiState`** (w `src/app/store.ts`, w bloku typu, np. obok `selectionActive`)

```ts
  selectedRowIds: number[];
  selectionAnchorId: number | null;
  rowAccounts: Record<number, number>;
  selectRow: (id: number) => void;
  toggleRow: (id: number) => void;
  selectRangeTo: (id: number) => void;
```

Zmień sygnaturę `setListContext` w typie na:

```ts
  setListContext: (ids: number[], mode: "thread" | "message", accounts?: Record<number, number>) => void;
```

- [ ] **Step 4: Dodaj wartości początkowe i akcje** (w `create<UiState>((set) => ({ ... }))`)

Wartości początkowe (obok `selectedMessageIds: []`):

```ts
  selectedRowIds: [],
  selectionAnchorId: null,
  rowAccounts: {},
```

Zmień `setListContext`:

```ts
  setListContext: (ids, mode, accounts = {}) =>
    set({ visibleMessageIds: ids, selectMode: mode, rowAccounts: accounts }),
```

Zmień `clearSelection`:

```ts
  clearSelection: () =>
    set({ selectionActive: false, selectedMessageIds: [], selectedRowIds: [], selectionAnchorId: null }),
```

Zmień `setSelectedThreadId` i `setSelectedMessageId`:

```ts
  setSelectedThreadId: (id) =>
    set({ selectedThreadId: id, selectedRowIds: id == null ? [] : [id], selectionAnchorId: id }),
  setSelectedMessageId: (id) =>
    set({ selectedMessageId: id, selectedRowIds: id == null ? [] : [id], selectionAnchorId: id }),
```

Dodaj nowe akcje:

```ts
  selectRow: (id) =>
    set((s) =>
      s.selectMode === "thread"
        ? { selectedThreadId: id, selectedRowIds: [id], selectionAnchorId: id }
        : { selectedMessageId: id, selectedRowIds: [id], selectionAnchorId: id }
    ),
  toggleRow: (id) =>
    set((s) => {
      const has = s.selectedRowIds.includes(id);
      const next = has ? s.selectedRowIds.filter((x) => x !== id) : [...s.selectedRowIds, id];
      if (next.length === 1) {
        return s.selectMode === "thread"
          ? { selectedRowIds: next, selectionAnchorId: id, selectedThreadId: next[0] }
          : { selectedRowIds: next, selectionAnchorId: id, selectedMessageId: next[0] };
      }
      if (next.length === 0) {
        return { selectedRowIds: next, selectionAnchorId: null, selectedThreadId: null, selectedMessageId: null };
      }
      return { selectedRowIds: next, selectionAnchorId: id };
    }),
  selectRangeTo: (id) =>
    set((s) => {
      const ids = s.visibleMessageIds;
      const anchor = s.selectionAnchorId ?? id;
      const i = ids.indexOf(anchor);
      const j = ids.indexOf(id);
      if (i === -1 || j === -1) {
        return { selectedRowIds: [id], selectionAnchorId: id };
      }
      const [lo, hi] = i <= j ? [i, j] : [j, i];
      const range = ids.slice(lo, hi + 1);
      if (range.length === 1) {
        return s.selectMode === "thread"
          ? { selectedRowIds: range, selectedThreadId: range[0] }
          : { selectedRowIds: range, selectedMessageId: range[0] };
      }
      return { selectedRowIds: range };
    }),
```

- [ ] **Step 5: Wyczyść zaznaczenie przy zmianie kontekstu** — dodaj `selectedRowIds: [], selectionAnchorId: null` do obiektów `set({...})` w: `setSelectedAccountId`, `setSelectedFolderId`, `setSelectedSmartFolder`, `setSelectedLabelId`, `setSearchQuery`, `clearSearch`.

- [ ] **Step 6: Uruchom testy — mają przejść**

Run: `npm test -- store.selection store.test`
Expected: PASS (nowe testy + istniejące `store.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/app/store.ts src/app/store.selection.test.ts
git commit -m "feat(store): unified row selection model with anchor and rowAccounts"
```

---

### Task 4: Queries — `useMoveToFolder` + rodzaj undo `"move"`

**Files:**
- Modify: `src/ipc/queries.ts` (nowy hook)
- Modify: `src/app/store.ts` (typ `undoToast` + `showUndoToast` o `"move"`)
- Modify: `src/features/shortcuts/UndoBar.tsx` (etykieta dla `"move"`)
- Test: `src/ipc/queries.test.tsx` (dodanie testu + mocka `moveMessages`)

**Interfaces:**
- Produces: `useMoveToFolder()` → mutacja `{ messageIds: number[]; targetFolderId: number }`; rozszerzony typ `undoToast.kind: "archive" | "delete" | "move"`.
- Consumes: `commands.moveMessages`, `invalidateAfterMove`.

- [ ] **Step 1: Napisz failing test** (w `src/ipc/queries.test.tsx`)

Dodaj `moveMessages: vi.fn(),` do mocka `commands`, dodaj `useMoveToFolder` do importu z `./queries`, i dopisz test (wzór jak `useDeleteLabel`):

```ts
  it("useMoveToFolder calls moveMessages and invalidates threads", async () => {
    vi.mocked(commands.moveMessages).mockResolvedValue({ status: "ok", data: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const qcWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMoveToFolder(), { wrapper: qcWrapper });
    result.current.mutate({ messageIds: [10, 20], targetFolderId: 7 });
    await waitFor(() => expect(commands.moveMessages).toHaveBeenCalledWith([10, 20], 7));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["threads"] })
    );
  });
```

> Jeśli plik nie importuje jeszcze `commands.refreshUnreadBadge`, mock `commands` musi zawierać `refreshUnreadBadge: vi.fn()` (wymagane przez `invalidateAfterMove`). Dodaj też `moveMessages: vi.fn()`.

- [ ] **Step 2: Uruchom test — ma failować**

Run: `npm test -- queries`
Expected: FAIL — `useMoveToFolder is not exported`.

- [ ] **Step 3: Dodaj hook w `queries.ts`** (po `useDelete`)

```ts
export function useMoveToFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageIds, targetFolderId }: { messageIds: number[]; targetFolderId: number }) =>
      commands.moveMessages(messageIds, targetFolderId).then(unwrap),
    onSuccess: () => invalidateAfterMove(queryClient),
  });
}
```

- [ ] **Step 4: Rozszerz `undoToast` o `"move"`** (w `src/app/store.ts`)

Zmień w typie `UiState`:

```ts
  undoToast: { kind: "archive" | "delete" | "move"; messageIds: number[] } | null;
  showUndoToast: (kind: "archive" | "delete" | "move", messageIds: number[]) => void;
```

- [ ] **Step 5: Dodaj etykietę dla `"move"` w `UndoBar.tsx`**

Otwórz `src/features/shortcuts/UndoBar.tsx`, znajdź wyznaczanie tekstu na podstawie `kind` (np. mapa lub ternary) i dodaj przypadek `"move"` → `"Moved"` (analogicznie do `"archive"` → `"Archived"`). Jeśli jest to obiekt-mapa, dodaj `move: "Moved"`.

- [ ] **Step 6: Uruchom testy + tsc**

Run: `npm test -- queries && npx tsc --noEmit`
Expected: PASS, brak błędów typów.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/queries.ts src/ipc/queries.test.tsx src/app/store.ts src/features/shortcuts/UndoBar.tsx
git commit -m "feat(queries): useMoveToFolder mutation and move undo kind"
```

---

### Task 5: Resolver thread→message (wspólny helper)

**Files:**
- Create: `src/shared/selection/resolveMessageIds.ts`
- Test: `src/shared/selection/resolveMessageIds.test.ts`

**Interfaces:**
- Produces: `async function resolveSelectedMessageIds(): Promise<number[]>` — w trybie `"message"` zwraca `selectedRowIds`; w `"thread"` woła `commands.messageIdsForThreads(selectedRowIds)`.
- Consumes: `useUiStore.getState()`, `commands.messageIdsForThreads`.

- [ ] **Step 1: Napisz failing test** — `src/shared/selection/resolveMessageIds.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ipc/bindings", () => ({
  commands: { messageIdsForThreads: vi.fn() },
}));

import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { resolveSelectedMessageIds } from "./resolveMessageIds";

beforeEach(() => {
  useUiStore.setState({ selectedRowIds: [], selectMode: "message" });
});

describe("resolveSelectedMessageIds", () => {
  it("returns rowIds directly in message mode", async () => {
    useUiStore.setState({ selectMode: "message", selectedRowIds: [5, 6] });
    expect(await resolveSelectedMessageIds()).toEqual([5, 6]);
    expect(commands.messageIdsForThreads).not.toHaveBeenCalled();
  });

  it("expands threads in thread mode", async () => {
    vi.mocked(commands.messageIdsForThreads).mockResolvedValue({ status: "ok", data: [100, 101, 200] });
    useUiStore.setState({ selectMode: "thread", selectedRowIds: [1, 2] });
    expect(await resolveSelectedMessageIds()).toEqual([100, 101, 200]);
    expect(commands.messageIdsForThreads).toHaveBeenCalledWith([1, 2]);
  });
});
```

- [ ] **Step 2: Uruchom test — ma failować**

Run: `npm test -- resolveMessageIds`
Expected: FAIL — brak modułu.

- [ ] **Step 3: Zaimplementuj helper** — `src/shared/selection/resolveMessageIds.ts`

```ts
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";

export async function resolveSelectedMessageIds(): Promise<number[]> {
  const s = useUiStore.getState();
  if (s.selectMode === "message") return s.selectedRowIds;
  const res = await commands.messageIdsForThreads(s.selectedRowIds);
  return res.status === "ok" ? res.data : [];
}
```

- [ ] **Step 4: Uruchom test — ma przejść**

Run: `npm test -- resolveMessageIds`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/selection/resolveMessageIds.ts src/shared/selection/resolveMessageIds.test.ts
git commit -m "feat(selection): resolveSelectedMessageIds thread-to-message helper"
```

---

### Task 6: Store — stan pickera folderu

**Files:**
- Modify: `src/app/store.ts`
- Test: `src/app/store.selection.test.ts` (dopisanie)

**Interfaces:**
- Produces: `folderPickerOpen: boolean`, `folderPickerTargetIds: number[]`, `folderPickerAccountId: number | null`, `openFolderPicker(ids: number[], accountId: number): void`, `closeFolderPicker(): void`.

- [ ] **Step 1: Napisz failing test** (dopisz do `store.selection.test.ts`)

```ts
describe("folder picker state", () => {
  it("openFolderPicker sets target and account; close resets", () => {
    useUiStore.getState().openFolderPicker([3, 4], 9);
    let s = useUiStore.getState();
    expect(s.folderPickerOpen).toBe(true);
    expect(s.folderPickerTargetIds).toEqual([3, 4]);
    expect(s.folderPickerAccountId).toBe(9);
    useUiStore.getState().closeFolderPicker();
    s = useUiStore.getState();
    expect(s.folderPickerOpen).toBe(false);
    expect(s.folderPickerTargetIds).toEqual([]);
    expect(s.folderPickerAccountId).toBeNull();
  });
});
```

- [ ] **Step 2: Uruchom — ma failować**

Run: `npm test -- store.selection`
Expected: FAIL — `openFolderPicker is not a function`.

- [ ] **Step 3: Dodaj do typu `UiState`**

```ts
  folderPickerOpen: boolean;
  folderPickerTargetIds: number[];
  folderPickerAccountId: number | null;
  openFolderPicker: (ids: number[], accountId: number) => void;
  closeFolderPicker: () => void;
```

- [ ] **Step 4: Dodaj wartości i akcje** (obok `snoozePicker*`)

```ts
  folderPickerOpen: false,
  folderPickerTargetIds: [],
  folderPickerAccountId: null,
  openFolderPicker: (ids, accountId) =>
    set({ folderPickerOpen: true, folderPickerTargetIds: ids, folderPickerAccountId: accountId }),
  closeFolderPicker: () =>
    set({ folderPickerOpen: false, folderPickerTargetIds: [], folderPickerAccountId: null }),
```

- [ ] **Step 5: Uruchom — ma przejść**

Run: `npm test -- store.selection`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/store.ts src/app/store.selection.test.ts
git commit -m "feat(store): folder picker state"
```

---

### Task 7: FolderPicker — komponent wyboru folderu docelowego

**Files:**
- Create: `src/features/reader/FolderPicker.tsx`
- Create: `src/features/reader/FolderPicker.css`
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx` (montaż `<FolderPicker />`)
- Test: `src/features/reader/FolderPicker.test.tsx`

**Interfaces:**
- Consumes: store `folderPickerOpen/TargetIds/AccountId`, `closeFolderPicker`, `showUndoToast`, `clearSelection`; `useFolders(accountId)`, `useMoveToFolder()`.
- Filtr folderów: pomijać `folder_type` ∈ {`drafts`, `sent`, `trash`}.

- [ ] **Step 1: Napisz failing test** — `src/features/reader/FolderPicker.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockMutate = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useFolders: () => ({
    data: [
      { id: 1, account_id: 9, name: "Work", folder_type: "custom", remote_path: "Work", unread_count: 0, total_count: 0 },
      { id: 2, account_id: 9, name: "Drafts", folder_type: "drafts", remote_path: "Drafts", unread_count: 0, total_count: 0 },
    ],
  }),
  useMoveToFolder: () => ({ mutate: mockMutate }),
}));

import { useUiStore } from "../../app/store";
import { FolderPicker } from "./FolderPicker";

beforeEach(() => {
  mockMutate.mockClear();
  useUiStore.setState({
    folderPickerOpen: true,
    folderPickerTargetIds: [10, 20],
    folderPickerAccountId: 9,
  });
});

describe("FolderPicker", () => {
  it("lists movable folders and hides drafts/sent/trash", () => {
    render(<FolderPicker />);
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.queryByText("Drafts")).toBeNull();
  });

  it("moving calls useMoveToFolder with target ids and folder id", () => {
    render(<FolderPicker />);
    fireEvent.click(screen.getByText("Work"));
    expect(mockMutate).toHaveBeenCalledWith({ messageIds: [10, 20], targetFolderId: 1 });
  });
});
```

- [ ] **Step 2: Uruchom — ma failować**

Run: `npm test -- FolderPicker`
Expected: FAIL — brak modułu.

- [ ] **Step 3: Zaimplementuj `FolderPicker.tsx`** (wzór jak `SnoozePicker` — overlay + lista)

```tsx
import { useFolders, useMoveToFolder } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import "./FolderPicker.css";

const HIDDEN_TYPES = new Set(["drafts", "sent", "trash"]);

export function FolderPicker() {
  const open = useUiStore((s) => s.folderPickerOpen);
  const targetIds = useUiStore((s) => s.folderPickerTargetIds);
  const accountId = useUiStore((s) => s.folderPickerAccountId);
  const close = useUiStore((s) => s.closeFolderPicker);
  const showUndoToast = useUiStore((s) => s.showUndoToast);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const setSelectedThreadId = useUiStore((s) => s.setSelectedThreadId);
  const move = useMoveToFolder();
  const { data: folders } = useFolders(accountId);

  if (!open) return null;

  const movable = (folders ?? []).filter((f) => !HIDDEN_TYPES.has(f.folder_type));

  function handlePick(folderId: number) {
    if (targetIds.length === 0) return;
    move.mutate({ messageIds: targetIds, targetFolderId: folderId });
    showUndoToast("move", targetIds);
    clearSelection();
    setSelectedThreadId(null);
    close();
  }

  return (
    <div className="folder-picker__overlay" role="dialog" aria-label="Move to folder" onClick={() => close()}>
      <div className="folder-picker" onClick={(e) => e.stopPropagation()}>
        <div className="folder-picker__title">Move to folder</div>
        <ul className="folder-picker__list">
          {movable.map((f) => (
            <li key={f.id}>
              <button type="button" className="folder-picker__item" onClick={() => handlePick(f.id)}>
                {f.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Dodaj `FolderPicker.css`** (skopiuj reguły overlay/list z `SnoozePicker.css`, zmieniając prefiks na `folder-picker`)

```css
.folder-picker__overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.folder-picker {
  background: var(--surface, #fff);
  border-radius: 10px;
  min-width: 280px;
  max-height: 60vh;
  overflow: auto;
  padding: 8px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
}
.folder-picker__title {
  font-weight: 600;
  padding: 8px 10px;
}
.folder-picker__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.folder-picker__item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.folder-picker__item:hover {
  background: var(--hover, rgba(0, 0, 0, 0.06));
}
```

- [ ] **Step 5: Zamontuj `<FolderPicker />` w `ShortcutsProvider.tsx`** — dodaj import i wstaw obok `<SnoozePicker />` (ok. linii 225).

```tsx
import { FolderPicker } from "../reader/FolderPicker";
```

```tsx
      <LabelPicker />
      <SnoozePicker />
      <FolderPicker />
```

- [ ] **Step 6: Uruchom testy + tsc**

Run: `npm test -- FolderPicker && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/reader/FolderPicker.tsx src/features/reader/FolderPicker.css src/features/shortcuts/ShortcutsProvider.tsx
git commit -m "feat(reader): folder picker for move-to-folder"
```

---

### Task 8: BulkActionPanel + przełączenie ReaderPane

**Files:**
- Create: `src/features/reader/BulkActionPanel.tsx`
- Create: `src/features/reader/BulkActionPanel.css`
- Modify: `src/features/reader/ReaderPane.tsx`
- Test: `src/features/reader/BulkActionPanel.test.tsx`

**Interfaces:**
- Consumes: store `selectedRowIds`, `selectMode`, `rowAccounts`, `clearSelection`, `setSelectedThreadId`, `showUndoToast`, `openLabelPicker`, `openSnoozePicker`, `openFolderPicker`; `useSetSeen`, `useArchive`, `useDelete`; `resolveSelectedMessageIds`.
- ReaderPane: gdy `selectedRowIds.length >= 2` renderuje `<BulkActionPanel />`.

- [ ] **Step 1: Napisz failing test** — `src/features/reader/BulkActionPanel.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mutateSeen = vi.fn();
const mutateArchive = vi.fn();
const mutateDelete = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useSetSeen: () => ({ mutate: mutateSeen }),
  useArchive: () => ({ mutate: mutateArchive }),
  useDelete: () => ({ mutate: mutateDelete }),
}));
vi.mock("../../shared/selection/resolveMessageIds", () => ({
  resolveSelectedMessageIds: vi.fn(async () => [10, 20]),
}));

import { useUiStore } from "../../app/store";
import { BulkActionPanel } from "./BulkActionPanel";

beforeEach(() => {
  mutateSeen.mockClear();
  mutateArchive.mockClear();
  mutateDelete.mockClear();
  useUiStore.setState({
    selectMode: "message",
    selectedRowIds: [10, 20],
    rowAccounts: { 10: 1, 20: 1 },
    undoToast: null,
  });
});

describe("BulkActionPanel", () => {
  it("shows count of selected rows", () => {
    render(<BulkActionPanel />);
    expect(screen.getByText(/2/)).toBeTruthy();
  });

  it("mark read resolves ids and calls setSeen(true)", async () => {
    render(<BulkActionPanel />);
    fireEvent.click(screen.getByRole("button", { name: /mark.*read/i }));
    await waitFor(() => expect(mutateSeen).toHaveBeenCalledWith({ ids: [10, 20], value: true }));
  });

  it("archive resolves ids and calls archive", async () => {
    render(<BulkActionPanel />);
    fireEvent.click(screen.getByRole("button", { name: /archive/i }));
    await waitFor(() => expect(mutateArchive).toHaveBeenCalledWith({ messageIds: [10, 20] }));
  });

  it("disables move-to-folder when selection spans multiple accounts", () => {
    useUiStore.setState({ rowAccounts: { 10: 1, 20: 2 } });
    render(<BulkActionPanel />);
    const moveBtn = screen.getByRole("button", { name: /move to folder/i }) as HTMLButtonElement;
    expect(moveBtn.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Uruchom — ma failować**

Run: `npm test -- BulkActionPanel`
Expected: FAIL — brak modułu.

- [ ] **Step 3: Zaimplementuj `BulkActionPanel.tsx`**

```tsx
import { useSetSeen, useArchive, useDelete } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { resolveSelectedMessageIds } from "../../shared/selection/resolveMessageIds";
import "./BulkActionPanel.css";

export function BulkActionPanel() {
  const selectedRowIds = useUiStore((s) => s.selectedRowIds);
  const rowAccounts = useUiStore((s) => s.rowAccounts);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const setSelectedThreadId = useUiStore((s) => s.setSelectedThreadId);
  const showUndoToast = useUiStore((s) => s.showUndoToast);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
  const openSnoozePicker = useUiStore((s) => s.openSnoozePicker);
  const openFolderPicker = useUiStore((s) => s.openFolderPicker);
  const setSeen = useSetSeen();
  const archive = useArchive();
  const del = useDelete();

  const count = selectedRowIds.length;
  const accounts = Array.from(
    new Set(selectedRowIds.map((id) => rowAccounts[id]).filter((a) => a != null))
  ) as number[];
  const singleAccount = accounts.length === 1 ? accounts[0] : null;

  async function withIds(fn: (ids: number[]) => void) {
    const ids = await resolveSelectedMessageIds();
    if (ids.length === 0) return;
    fn(ids);
  }

  function markSeen(value: boolean) {
    void withIds((ids) => {
      setSeen.mutate({ ids, value });
      clearSelection();
    });
  }

  function move(kind: "archive" | "delete") {
    void withIds((ids) => {
      if (kind === "archive") archive.mutate({ messageIds: ids });
      else del.mutate({ messageIds: ids });
      showUndoToast(kind, ids);
      clearSelection();
      setSelectedThreadId(null);
    });
  }

  function openMove() {
    if (singleAccount == null) return;
    void withIds((ids) => openFolderPicker(ids, singleAccount));
  }

  return (
    <div className="bulk-panel" aria-label="bulk-actions">
      <div className="bulk-panel__count">Selected {count} messages</div>
      <div className="bulk-panel__actions">
        <button type="button" onClick={() => markSeen(true)}>Mark as read</button>
        <button type="button" onClick={() => markSeen(false)}>Mark as unread</button>
        <button type="button" onClick={() => move("archive")}>Move to archive</button>
        <button type="button" onClick={() => move("delete")}>Delete</button>
        <button type="button" disabled={singleAccount == null} onClick={() => openMove()}>
          Move to folder…
        </button>
        <button type="button" onClick={() => void withIds((ids) => openLabelPicker(ids))}>Label…</button>
        <button type="button" onClick={() => void withIds((ids) => openSnoozePicker(ids))}>Snooze…</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Dodaj `BulkActionPanel.css`**

```css
.bulk-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 24px;
}
.bulk-panel__count {
  font-size: 18px;
  font-weight: 600;
}
.bulk-panel__actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 240px;
}
.bulk-panel__actions button {
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
  background: var(--surface, #fff);
  cursor: pointer;
  text-align: center;
}
.bulk-panel__actions button:hover:not(:disabled) {
  background: var(--hover, rgba(0, 0, 0, 0.06));
}
.bulk-panel__actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Przełącz `ReaderPane.tsx`** — pokaż panel masowy przy 2+ zaznaczonych

```tsx
import { useUiStore } from "../../app/store";
import { useThreadForMessage } from "../../ipc/queries";
import { ConversationView } from "./ConversationView";
import { BulkActionPanel } from "./BulkActionPanel";
import "./reader.css";

function MessageReader({ messageId }: { messageId: number }) {
  const { data: threadId, isLoading } = useThreadForMessage(messageId);

  if (isLoading) {
    return <p className="loading-state">Loading…</p>;
  }
  if (threadId == null) {
    return <p className="empty-state">Select a conversation to read</p>;
  }
  return <ConversationView threadId={threadId} />;
}

export function ReaderPane() {
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectedMessageId = useUiStore((s) => s.selectedMessageId);
  const selectedRowIds = useUiStore((s) => s.selectedRowIds);

  let content;
  if (selectedRowIds.length >= 2) {
    content = <BulkActionPanel />;
  } else if (selectedThreadId != null) {
    content = <ConversationView threadId={selectedThreadId} />;
  } else if (selectedMessageId != null) {
    content = <MessageReader messageId={selectedMessageId} />;
  } else {
    content = <p className="empty-state">Select a conversation to read</p>;
  }

  return (
    <section className="pane reader-pane" aria-label="reader">
      {content}
    </section>
  );
}
```

- [ ] **Step 6: Uruchom testy + tsc**

Run: `npm test -- BulkActionPanel ReaderPane && npx tsc --noEmit`
Expected: PASS (jeśli `ReaderPane.test` istnieje, musi nadal przechodzić — panel pojawia się tylko przy 2+).

- [ ] **Step 7: Commit**

```bash
git add src/features/reader/BulkActionPanel.tsx src/features/reader/BulkActionPanel.css src/features/reader/ReaderPane.tsx
git commit -m "feat(reader): bulk action panel for multi-selection"
```

---

### Task 9: MessageListPane — model klikania (shift/ctrl/zwykły) i usunięcie starego UI

**Files:**
- Modify: `src/features/message-list/MessageListPane.tsx`
- Test: `src/features/message-list/MessageListPane.test.tsx` (przepisanie sekcji selekcji)

**Interfaces:**
- Consumes: store `selectedRowIds`, `selectRow`, `toggleRow`, `selectRangeTo`, `setListContext(ids, mode, accounts)`.
- Usuwa: przycisk „Select", pasek `message-list__selection-bar`, checkboxy w `SmartRow`, użycia `useUnsnooze`, `useSetSeen`, `openLabelPicker`, `openSnoozePicker`, `selectionActive`, `toggleSelectionMode`, `toggleMessageSelected`, `clearSelection` (z tego komponentu).

- [ ] **Step 1: Napisz failing test** — w `MessageListPane.test.tsx` dodaj test klikania z modyfikatorami (dopasuj mocki store do nowego modelu: dodaj `selectRow`, `toggleRow`, `selectRangeTo`, `selectedRowIds: []`).

```tsx
  it("plain click calls selectRow; ctrl click calls toggleRow; shift click calls selectRangeTo", () => {
    const selectRow = vi.fn();
    const toggleRow = vi.fn();
    const selectRangeTo = vi.fn();
    mockStore({ selectRow, toggleRow, selectRangeTo, selectedRowIds: [] });
    render(<MessageListPane />);
    const rows = screen.getAllByRole("option");
    fireEvent.click(rows[0]);
    expect(selectRow).toHaveBeenCalled();
    fireEvent.click(rows[1], { ctrlKey: true });
    expect(toggleRow).toHaveBeenCalled();
    fireEvent.click(rows[2], { shiftKey: true });
    expect(selectRangeTo).toHaveBeenCalled();
  });
```

> `mockStore` to istniejący w pliku helper ustawiający `useUiStore` (dopasuj do faktycznej nazwy/wzoru w teście). Usuń/zamień stare testy odwołujące się do przycisku „Select", checkboxów i paska akcji (`mockOpenLabelPicker`, `mockOpenSnoozePicker` w kontekście paska selekcji).

- [ ] **Step 2: Uruchom — ma failować**

Run: `npm test -- MessageListPane`
Expected: FAIL (brak handlerów / stare testy paska selekcji).

- [ ] **Step 3: Dodaj wspólny handler i przekaż do wierszy**

W `MessageListPane` dodaj selektory store i handler:

```tsx
  const selectedRowIds = useUiStore((s) => s.selectedRowIds);
  const selectRow = useUiStore((s) => s.selectRow);
  const toggleRow = useUiStore((s) => s.toggleRow);
  const selectRangeTo = useUiStore((s) => s.selectRangeTo);

  function handleRowClick(e: React.MouseEvent, rowId: number) {
    if (e.shiftKey) selectRangeTo(rowId);
    else if (e.metaKey || e.ctrlKey) toggleRow(rowId);
    else selectRow(rowId);
  }
```

Zmień `onClick` w `ThreadRow` i `SmartRow` tak, by przyjmowały `onClick: (e: React.MouseEvent, id: number) => void` zamiast `onSelect: (id) => void`, i wołały `onClick(e, id)` w `div.message-row`. Podświetlenie: `isSelected = selectedRowIds.includes(id)` (przekazywane z `MessageListPane`).

W miejscach renderu wierszy:

```tsx
// ThreadRow
isSelected={selectedRowIds.includes(thread.thread_id)}
onClick={handleRowClick}
// w komponencie: onClick={(e) => onClick(e, thread.thread_id)}

// SmartRow
isSelected={selectedRowIds.includes(row.message_id)}
onClick={handleRowClick}
// w komponencie: onClick={(e) => onClick(e, row.message_id)}
```

- [ ] **Step 4: Usuń stary UI selekcji**

- Usuń przycisk „Select" (`message-list__select-toggle`) z nagłówka.
- Usuń cały blok `{isFlatMode && selectionActive && ( ... message-list__selection-bar ... )}`.
- Usuń z `SmartRow` propsy `selectable`, `selected`, `onToggleSelect` i checkbox (blok `{selectable && (<input type="checkbox" .../>)}`).
- Usuń nieużywane importy/hooki: `useUnsnooze`, `useSetSeen`, oraz selektory `selectionActive`, `toggleSelectionMode`, `toggleMessageSelected`, `clearSelection`, `openLabelPicker`, `openSnoozePicker`, `selectedMessageIds`.

- [ ] **Step 5: Rozszerz `setListContext` o mapę kont**

Zmień efekt ustawiający kontekst listy:

```tsx
  useEffect(() => {
    const accounts: Record<number, number> = {};
    if (isFlatMode) {
      for (const r of rawItems as SmartMessageRow[]) accounts[r.message_id] = r.account_id;
    } else {
      for (const t of rawItems as ThreadSummary[]) accounts[t.thread_id] = t.account_id;
    }
    const ids = isFlatMode
      ? (rawItems as SmartMessageRow[]).map((r) => r.message_id)
      : (rawItems as ThreadSummary[]).map((t) => t.thread_id);
    setListContext(ids, isFlatMode ? "message" : "thread", accounts);
  }, [rawItems, isFlatMode, setListContext]);
```

- [ ] **Step 6: Uruchom testy + tsc**

Run: `npm test -- MessageListPane && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(message-list): shift/ctrl click selection, remove checkbox UI"
```

---

### Task 10: Skróty klawiszowe i paleta — przepięcie na nowy model

**Files:**
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx`
- Modify: `src/features/shortcuts/CommandPalette.tsx`
- Test: dopasować istniejące testy skrótów, jeśli istnieją (`*.test.tsx` w `features/shortcuts`).

**Interfaces:**
- Consumes: `selectedRowIds`, `resolveSelectedMessageIds`, `openLabelPicker`, `openSnoozePicker`, `clearSelection`, `setSelectedThreadId`.

- [ ] **Step 1: Przepisz `doMove` w `ShortcutsProvider.tsx`** (zastępuje wersję czytającą `selectionActive`/`selectedMessageIds`)

```tsx
  const doMove = useCallback(
    (kind: "archive" | "delete") => {
      const s = useUiStore.getState();
      if (s.selectedRowIds.length >= 1) {
        void resolveSelectedMessageIds().then((ids) => {
          if (ids.length === 0) return;
          if (kind === "archive") archive.mutate({ messageIds: ids });
          else del.mutate({ messageIds: ids });
          s.showUndoToast(kind, ids);
          s.clearSelection();
          s.setSelectedThreadId(null);
        });
        return;
      }
      if (s.selectedThreadId != null) {
        const messages = queryClient.getQueryData<{ id: number }[]>(["thread-messages", s.selectedThreadId]);
        const ids = (messages ?? []).map((m) => m.id);
        if (ids.length === 0) return;
        if (kind === "archive") archive.mutate({ messageIds: ids });
        else del.mutate({ messageIds: ids });
        s.showUndoToast(kind, ids);
        s.setSelectedThreadId(null);
      }
    },
    [archive, del, queryClient]
  );
```

Dodaj import: `import { resolveSelectedMessageIds } from "../../shared/selection/resolveMessageIds";`

- [ ] **Step 2: Przepisz handlery `label` i `snooze`** (sekcja `handlers`)

```tsx
      label: () => {
        const s = useUiStore.getState();
        if (s.selectedRowIds.length >= 1) {
          void resolveSelectedMessageIds().then((ids) => { if (ids.length) s.openLabelPicker(ids); });
        } else if (s.replyTargetId != null) {
          s.openLabelPicker([s.replyTargetId]);
        }
      },
      snooze: () => {
        const s = useUiStore.getState();
        if (s.selectedRowIds.length >= 1) {
          void resolveSelectedMessageIds().then((ids) => { if (ids.length) s.openSnoozePicker(ids); });
        } else if (s.replyTargetId != null) {
          s.openSnoozePicker([s.replyTargetId]);
        }
      },
```

- [ ] **Step 3: Przepisz `CommandPalette.tsx`** (linie ~45–46) na nowy model

```tsx
      if (s.selectedRowIds.length >= 1) {
        void resolveSelectedMessageIds().then((ids) => { if (ids.length) s.openLabelPicker(ids); });
      } else if (s.replyTargetId != null) s.openLabelPicker([s.replyTargetId]);
```

Dodaj import `resolveSelectedMessageIds` w `CommandPalette.tsx`. (Analogicznie potraktuj ewentualne sąsiednie użycia `selectionActive`/`selectedMessageIds` w tym pliku.)

- [ ] **Step 4: Uruchom testy + tsc**

Run: `npm test -- shortcuts CommandPalette && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/shortcuts/ShortcutsProvider.tsx src/features/shortcuts/CommandPalette.tsx
git commit -m "feat(shortcuts): bulk actions on row selection model"
```

---

### Task 11: Usunięcie starego modelu zaznaczenia (cleanup)

**Files:**
- Modify: `src/app/store.ts`
- Modify: testy z mockami store: `src/app/AppShell.test.tsx`, `src/features/mailbox/MailboxRail.test.tsx` (i `MailboxRail.pinned.test.tsx`, `MailboxRail.folder-actions.test.tsx`) — usunąć odwołania do starych pól, jeśli powodują błędy typów.

**Interfaces:**
- Usuwa z `UiState`: `selectionActive`, `selectedMessageIds`, `toggleSelectionMode`, `toggleMessageSelected`, `selectAll`.

- [ ] **Step 1: Znajdź wszystkie odwołania**

Run: `grep -rn "selectionActive\|selectedMessageIds\|toggleSelectionMode\|toggleMessageSelected\|selectAll" src`
Expected: lista miejsc do usunięcia (po Taskach 9–10 powinny zostać tylko: definicje w `store.ts` oraz mocki w testach).

- [ ] **Step 2: Usuń pola i akcje ze `store.ts`** — z typu `UiState` oraz z obiektu inicjalnego/akcji (`selectionActive`, `selectedMessageIds`, `toggleSelectionMode`, `toggleMessageSelected`, `selectAll`).

- [ ] **Step 3: Usuń odwołania w mockach testów** — w plikach z grep usuń linie `selectionActive: ...`, `selectedMessageIds: ...`, `toggleSelectionMode: vi.fn()`, `toggleMessageSelected: vi.fn()`, `selectAll: vi.fn()`.

- [ ] **Step 4: Pełny zielony przebieg**

Run: `npx tsc --noEmit && npm test && cargo test -p am-sync && cargo build`
Expected: PASS we wszystkich.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(store): remove legacy checkbox selection model"
```

---

## Self-Review

**Spec coverage:**
- Model stanu (`selectedRowIds`/anchor/rowAccounts, sync, czyszczenie) → Task 3, 6, 11.
- Interakcja shift/ctrl/zwykły klik + usunięcie starego UI → Task 9.
- Próg 2+ → panel; 1 → czytnik; 0 → pusty → Task 8 (ReaderPane).
- 7 akcji w panelu → Task 8 (BulkActionPanel).
- Move-to-folder „jedno konto" → Task 8 (disabled gdy >1 konto) + Task 7 (picker) + Task 4 (hook) + Task 1–2 (backend).
- Thread→message resolution → Task 5 (helper) + Task 2 (komenda).
- Undo dla move → Task 4 (`"move"` kind) + Task 7 (toast).
- Skróty/paleta masowo → Task 10.
- Testy → w każdym tasku + pełny przebieg w Task 11.

**Placeholder scan:** brak „TBD/TODO"; każdy krok ma kod lub dokładne instrukcje. Kroki edycji istniejących plików (UndoBar, MessageListPane, CommandPalette) wskazują dokładne miejsca i podają kod do wstawienia/zamiany.

**Type consistency:** `resolveSelectedMessageIds` (Task 5) używane spójnie w Task 8/10; `useMoveToFolder({ messageIds, targetFolderId })` (Task 4) wołane spójnie w Task 7; `openFolderPicker(ids, accountId)` (Task 6) wołane w Task 7/8; `showUndoToast("move", ids)` zgodne z rozszerzonym typem (Task 4). `setListContext(ids, mode, accounts)` — 3. argument opcjonalny (Task 3), wołany z mapą w Task 9.
