# Pinned Folders + Inbox Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać przypinanie folderów (menu kontekstowe) oraz stałą sekcję INBOX nad listą Smart Folders w sidebarze.

**Architecture:** Stan „przypięte" trzymany w store `settings` (klucz `folders.pinned.{accountId}` = JSON z ID), bez zmian w warstwie Rust. Foldery wszystkich kont pobierane przez `useQueries` (współdzielony cache z `useFolders`). Czysta logika selekcji w `pinned.ts`, render w `MailboxRail`, menu w osobnym `RailContextMenu`.

**Tech Stack:** React 19, TypeScript, @tanstack/react-query v5, zustand, lucide-react, vitest + @testing-library/react (happy-dom).

## Global Constraints

- Brak komentarzy w kodzie; wszystkie identyfikatory po angielsku.
- Commity: Conventional Commits 1.0.0; bez co-authora; bez `push`.
- Trwałość wyłącznie w store `settings` (komendy `getSettings` / `setSetting`); bez migracji DB i bez regeneracji bindingów specta.
- Sortowanie nazw folderów: `localeCompare(..., "pl", { sensitivity: "base" })`.
- Folder typu `inbox` nie jest przypinalny (wykluczony z sekcji przypiętych i z menu).
- Testy uruchamiane przez `npx vitest run <ścieżka>`.

---

### Task 1: Pure selection helpers (`pinned.ts`)

**Files:**
- Create: `src/features/mailbox/pinned.ts`
- Test: `src/features/mailbox/pinned.test.ts`

**Interfaces:**
- Consumes: `Account`, `Folder` z `src/ipc/bindings`; `decodeImapUtf7` z `./folder-tree`.
- Produces:
  - `pinKey(accountId: number): string`
  - `parsePinnedMap(settings: [string, string][]): Map<number, number[]>`
  - `togglePinnedIds(ids: number[], folderId: number): number[]`
  - `isFolderPinned(pinnedMap: Map<number, number[]>, accountId: number, folderId: number): boolean`
  - `type InboxEntry = { account: Account; inbox: Folder }`
  - `selectInboxes(accounts: Account[], foldersByAccount: Map<number, Folder[]>): InboxEntry[]`
  - `type PinnedGroup = { account: Account; folders: Folder[] }`
  - `selectPinnedByAccount(accounts: Account[], foldersByAccount: Map<number, Folder[]>, pinnedMap: Map<number, number[]>): PinnedGroup[]`

- [ ] **Step 1: Write the failing test**

Create `src/features/mailbox/pinned.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Account, Folder } from "../../ipc/bindings";
import {
  pinKey,
  parsePinnedMap,
  togglePinnedIds,
  isFolderPinned,
  selectInboxes,
  selectPinnedByAccount,
} from "./pinned";

function account(id: number, email = `a${id}@x.pl`): Account {
  return {
    id,
    email,
    display_name: `Account ${id}`,
    provider_type: "imap",
    color: null,
    position: id,
    requires_reauth: false,
  };
}

function folder(id: number, accountId: number, name: string, folder_type: Folder["folder_type"]): Folder {
  return {
    id,
    account_id: accountId,
    remote_path: name,
    name,
    folder_type,
    unread_count: 0,
    total_count: 0,
  };
}

describe("pinned helpers", () => {
  it("builds the per-account settings key", () => {
    expect(pinKey(7)).toBe("folders.pinned.7");
  });

  it("parses only pinned settings entries into a map", () => {
    const map = parsePinnedMap([
      ["folders.pinned.1", "[3,5]"],
      ["images.autoload.1", "true"],
      ["folders.pinned.2", "[9]"],
      ["folders.pinned.3", "not-json"],
    ]);
    expect(map.get(1)).toEqual([3, 5]);
    expect(map.get(2)).toEqual([9]);
    expect(map.has(3)).toBe(false);
  });

  it("toggles a folder id in and out of the list", () => {
    expect(togglePinnedIds([3, 5], 7)).toEqual([3, 5, 7]);
    expect(togglePinnedIds([3, 5, 7], 5)).toEqual([3, 7]);
  });

  it("reports pinned state for an account folder", () => {
    const map = new Map<number, number[]>([[1, [5]]]);
    expect(isFolderPinned(map, 1, 5)).toBe(true);
    expect(isFolderPinned(map, 1, 9)).toBe(false);
    expect(isFolderPinned(map, 2, 5)).toBe(false);
  });

  it("selects the inbox folder per account, skipping accounts without one", () => {
    const accounts = [account(1), account(2)];
    const byAccount = new Map<number, Folder[]>([
      [1, [folder(10, 1, "INBOX", "inbox"), folder(11, 1, "Work", "custom")]],
      [2, [folder(20, 2, "Sent", "sent")]],
    ]);
    const entries = selectInboxes(accounts, byAccount);
    expect(entries).toHaveLength(1);
    expect(entries[0].account.id).toBe(1);
    expect(entries[0].inbox.id).toBe(10);
  });

  it("groups pinned folders per account, sorted, excluding inbox and empty groups", () => {
    const accounts = [account(1), account(2), account(3)];
    const byAccount = new Map<number, Folder[]>([
      [1, [
        folder(10, 1, "INBOX", "inbox"),
        folder(11, 1, "Zlecenia", "custom"),
        folder(12, 1, "Archiwum", "archive"),
        folder(13, 1, "Nieprzypięty", "custom"),
      ]],
      [2, [folder(20, 2, "INBOX", "inbox")]],
      [3, []],
    ]);
    const pinnedMap = new Map<number, number[]>([
      [1, [11, 12, 10]],
      [2, [20]],
    ]);
    const groups = selectPinnedByAccount(accounts, byAccount, pinnedMap);
    expect(groups).toHaveLength(1);
    expect(groups[0].account.id).toBe(1);
    expect(groups[0].folders.map((f) => f.id)).toEqual([12, 11]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/mailbox/pinned.test.ts`
Expected: FAIL (`Failed to resolve import "./pinned"` / functions not defined).

- [ ] **Step 3: Write minimal implementation**

Create `src/features/mailbox/pinned.ts`:

```ts
import type { Account, Folder } from "../../ipc/bindings";
import { decodeImapUtf7 } from "./folder-tree";

const PIN_KEY_PREFIX = "folders.pinned.";

export function pinKey(accountId: number): string {
  return `${PIN_KEY_PREFIX}${accountId}`;
}

export function parsePinnedMap(settings: [string, string][]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const [key, value] of settings) {
    if (!key.startsWith(PIN_KEY_PREFIX)) continue;
    const accountId = Number(key.slice(PIN_KEY_PREFIX.length));
    if (!Number.isInteger(accountId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      map.set(accountId, parsed.filter((x): x is number => typeof x === "number"));
    }
  }
  return map;
}

export function togglePinnedIds(ids: number[], folderId: number): number[] {
  return ids.includes(folderId) ? ids.filter((id) => id !== folderId) : [...ids, folderId];
}

export function isFolderPinned(
  pinnedMap: Map<number, number[]>,
  accountId: number,
  folderId: number,
): boolean {
  return pinnedMap.get(accountId)?.includes(folderId) ?? false;
}

export type InboxEntry = { account: Account; inbox: Folder };

export function selectInboxes(
  accounts: Account[],
  foldersByAccount: Map<number, Folder[]>,
): InboxEntry[] {
  const entries: InboxEntry[] = [];
  for (const account of accounts) {
    const folders = foldersByAccount.get(account.id) ?? [];
    const inbox = folders.find((f) => f.folder_type === "inbox");
    if (inbox) entries.push({ account, inbox });
  }
  return entries;
}

export type PinnedGroup = { account: Account; folders: Folder[] };

export function selectPinnedByAccount(
  accounts: Account[],
  foldersByAccount: Map<number, Folder[]>,
  pinnedMap: Map<number, number[]>,
): PinnedGroup[] {
  const groups: PinnedGroup[] = [];
  for (const account of accounts) {
    const ids = pinnedMap.get(account.id);
    if (!ids || ids.length === 0) continue;
    const idSet = new Set(ids);
    const folders = (foldersByAccount.get(account.id) ?? []).filter(
      (f) => idSet.has(f.id) && f.folder_type !== "inbox",
    );
    folders.sort((a, b) =>
      decodeImapUtf7(a.name).localeCompare(decodeImapUtf7(b.name), "pl", { sensitivity: "base" }),
    );
    if (folders.length > 0) groups.push({ account, folders });
  }
  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/mailbox/pinned.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/mailbox/pinned.ts src/features/mailbox/pinned.test.ts
git commit -m "feat(rail): pinned folders selection helpers"
```

---

### Task 2: React Query hooks (`queries.ts`)

**Files:**
- Modify: `src/ipc/queries.ts` (imports at top; add three exports)
- Test: `src/ipc/queries.pinned.test.tsx`

**Interfaces:**
- Consumes: `commands.getSettings`, `commands.setSetting`, `commands.listFolders` z `./bindings`; `parsePinnedMap`, `pinKey`, `togglePinnedIds` z `../features/mailbox/pinned`.
- Produces:
  - `usePinnedMap()` → React Query result z `data: Map<number, number[]>`.
  - `useTogglePinnedFolder()` → mutacja przyjmująca `{ accountId: number; folderId: number }`.
  - `useAllAccountFolders(accounts: Account[]): Map<number, Folder[]>`.

- [ ] **Step 1: Write the failing test**

Create `src/ipc/queries.pinned.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./bindings", () => ({
  commands: {
    getSettings: vi.fn(),
    setSetting: vi.fn(),
    listFolders: vi.fn(),
  },
  events: {},
}));

import { commands } from "./bindings";
import { usePinnedMap, useTogglePinnedFolder } from "./queries";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("pinned folder queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses settings into a pinned map", async () => {
    vi.mocked(commands.getSettings).mockResolvedValue({
      status: "ok",
      data: [["folders.pinned.2", "[3,9]"], ["images.autoload.1", "true"]],
    });
    const { result } = renderHook(() => usePinnedMap(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeInstanceOf(Map));
    expect(result.current.data!.get(2)).toEqual([3, 9]);
  });

  it("adds a folder id and persists the toggled list", async () => {
    vi.mocked(commands.getSettings).mockResolvedValue({
      status: "ok",
      data: [["folders.pinned.1", "[5]"]],
    });
    vi.mocked(commands.setSetting).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useTogglePinnedFolder(), { wrapper });
    result.current.mutate({ accountId: 1, folderId: 7 });
    await waitFor(() =>
      expect(commands.setSetting).toHaveBeenCalledWith("folders.pinned.1", "[5,7]"),
    );
  });

  it("removes a folder id when already pinned", async () => {
    vi.mocked(commands.getSettings).mockResolvedValue({
      status: "ok",
      data: [["folders.pinned.1", "[5,7]"]],
    });
    vi.mocked(commands.setSetting).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useTogglePinnedFolder(), { wrapper });
    result.current.mutate({ accountId: 1, folderId: 5 });
    await waitFor(() =>
      expect(commands.setSetting).toHaveBeenCalledWith("folders.pinned.1", "[7]"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ipc/queries.pinned.test.tsx`
Expected: FAIL (`usePinnedMap` / `useTogglePinnedFolder` not exported).

- [ ] **Step 3: Write minimal implementation**

In `src/ipc/queries.ts`, update the first import line to add `useQueries`:

```ts
import { useQuery, useQueries, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
```

Update the types import line (currently `import type { Account, Endpoints, ... } from "./bindings";`) to also include `Folder`:

```ts
import type { Account, Endpoints, Folder, Label, MessageFlag, OutgoingMessage, Rule, RuleInput, SendError, Signature, SmartFolderKind, SmartMessageRow } from "./bindings";
```

Add a new import below the existing imports:

```ts
import { parsePinnedMap, pinKey, togglePinnedIds } from "../features/mailbox/pinned";
```

Append these exports at the end of the file:

```ts
export function usePinnedMap() {
  return useQuery({
    queryKey: ["pinned-folders"],
    queryFn: () =>
      commands
        .getSettings()
        .then(unwrap)
        .then((all) => parsePinnedMap(all)),
  });
}

export function useTogglePinnedFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ accountId, folderId }: { accountId: number; folderId: number }) => {
      const all = await commands.getSettings().then(unwrap);
      const current = parsePinnedMap(all).get(accountId) ?? [];
      const next = togglePinnedIds(current, folderId);
      await commands.setSetting(pinKey(accountId), JSON.stringify(next)).then(unwrap);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pinned-folders"] });
    },
  });
}

export function useAllAccountFolders(accounts: Account[]): Map<number, Folder[]> {
  const results = useQueries({
    queries: accounts.map((account) => ({
      queryKey: ["folders", account.id],
      queryFn: () => commands.listFolders(account.id).then(unwrap),
    })),
  });
  const map = new Map<number, Folder[]>();
  accounts.forEach((account, index) => {
    const data = results[index]?.data;
    if (data) map.set(account.id, data);
  });
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ipc/queries.pinned.test.tsx`
Expected: PASS (3 tests).

Note: `useAllAccountFolders` jest cienkim agregatorem `useQueries`; pokrywa go test integracyjny railu w Task 4 (render sekcji INBOX i przypiętych).

- [ ] **Step 5: Commit**

```bash
git add src/ipc/queries.ts src/ipc/queries.pinned.test.tsx
git commit -m "feat(rail): queries for pinned folders and all-account folders"
```

---

### Task 3: Context menu component (`RailContextMenu.tsx`)

**Files:**
- Create: `src/features/mailbox/RailContextMenu.tsx`
- Modify: `src/features/mailbox/MailboxRail.css` (append context-menu styles)
- Test: `src/features/mailbox/RailContextMenu.test.tsx`

**Interfaces:**
- Produces:
  - `type ContextMenuItem = { label: string; onClick: () => void }`
  - `RailContextMenu(props: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void })`

- [ ] **Step 1: Write the failing test**

Create `src/features/mailbox/RailContextMenu.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RailContextMenu } from "./RailContextMenu";

describe("RailContextMenu", () => {
  afterEach(() => cleanup());

  it("renders the provided items", () => {
    render(
      <RailContextMenu x={10} y={20} onClose={vi.fn()} items={[{ label: "Przypnij", onClick: vi.fn() }]} />,
    );
    expect(screen.getByRole("menuitem", { name: "Przypnij" })).toBeTruthy();
  });

  it("fires onClick and onClose when an item is chosen", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(
      <RailContextMenu x={0} y={0} onClose={onClose} items={[{ label: "Odepnij", onClick }]} />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Odepnij" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <RailContextMenu x={0} y={0} onClose={onClose} items={[{ label: "Przypnij", onClick: vi.fn() }]} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/mailbox/RailContextMenu.test.tsx`
Expected: FAIL (`Failed to resolve import "./RailContextMenu"`).

- [ ] **Step 3: Write minimal implementation**

Create `src/features/mailbox/RailContextMenu.tsx`:

```tsx
import { useEffect, useRef } from "react";

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
};

export function RailContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="rail__context-menu" style={{ top: y, left: x }} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="rail__context-menu-item"
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
```

Append to `src/features/mailbox/MailboxRail.css`:

```css
.rail__context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 150px;
  padding: 4px;
  background: var(--bg-rail);
  border: 1px solid var(--rail-border);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
}
.rail__context-menu-item {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--rail-item);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.rail__context-menu-item:hover {
  background: var(--rail-hover);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/mailbox/RailContextMenu.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/mailbox/RailContextMenu.tsx src/features/mailbox/RailContextMenu.test.tsx src/features/mailbox/MailboxRail.css
git commit -m "feat(rail): context menu component"
```

---

### Task 4: Wire INBOX + pinned sections into the rail (`MailboxRail.tsx`)

**Files:**
- Modify: `src/features/mailbox/MailboxRail.tsx`
- Modify: `src/features/mailbox/MailboxRail.css` (append `rail__subsection`)
- Test: `src/features/mailbox/MailboxRail.test.tsx`

**Interfaces:**
- Consumes: `usePinnedMap`, `useTogglePinnedFolder`, `useAllAccountFolders` z `../../ipc/queries`; `selectInboxes`, `selectPinnedByAccount`, `isFolderPinned` z `./pinned`; `RailContextMenu` z `./RailContextMenu`; `decodeImapUtf7` z `./folder-tree`.

- [ ] **Step 1: Write the failing test**

Create `src/features/mailbox/MailboxRail.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Account, Folder } from "../../ipc/bindings";

const mutate = vi.fn();

const accounts: Account[] = [
  { id: 1, email: "a1@x.pl", display_name: "Konto A", provider_type: "imap", color: null, position: 1, requires_reauth: false },
  { id: 2, email: "a2@x.pl", display_name: "Konto B", provider_type: "imap", color: null, position: 2, requires_reauth: false },
];

const foldersByAccount = new Map<number, Folder[]>([
  [1, [
    { id: 10, account_id: 1, remote_path: "INBOX", name: "INBOX", folder_type: "inbox", unread_count: 3, total_count: 9 },
    { id: 11, account_id: 1, remote_path: "Klienci", name: "Klienci", folder_type: "custom", unread_count: 0, total_count: 2 },
  ]],
  [2, [
    { id: 20, account_id: 2, remote_path: "INBOX", name: "INBOX", folder_type: "inbox", unread_count: 0, total_count: 4 },
  ]],
]);

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({ data: accounts, isLoading: false }),
  useFolders: () => ({ data: foldersByAccount.get(1) }),
  useLabels: () => ({ data: [] }),
  useAllAccountFolders: () => foldersByAccount,
  usePinnedMap: () => ({ data: new Map<number, number[]>([[1, [11]]]) }),
  useTogglePinnedFolder: () => ({ mutate }),
}));

vi.mock("../../app/store", () => ({ useUiStore: vi.fn() }));

import { useUiStore } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseUiStore = vi.mocked(useUiStore);

function setupStore() {
  mockUseUiStore.mockImplementation((selector: (s: any) => unknown) => {
    const state = {
      selectedAccountId: null,
      selectedFolderId: null,
      selectedSmartFolder: null,
      selectedLabelId: null,
      searchQuery: "",
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedSmartFolder: vi.fn(),
      setSelectedLabelId: vi.fn(),
      openLabelPicker: vi.fn(),
      openSettings: vi.fn(),
      setSearchQuery: vi.fn(),
      clearSearch: vi.fn(),
      setFocusSearch: vi.fn(),
    };
    return selector ? selector(state) : state;
  });
}

describe("MailboxRail pinned + inbox sections", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders an INBOX row per account", () => {
    setupStore();
    render(<MailboxRail />);
    const inboxHeader = screen.getByText("Inbox");
    expect(inboxHeader).toBeTruthy();
    expect(screen.getAllByText("Konto A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Konto B").length).toBeGreaterThan(0);
  });

  it("renders pinned folders grouped under their account", () => {
    setupStore();
    render(<MailboxRail />);
    expect(screen.getByText("Klienci")).toBeTruthy();
  });

  it("toggles a pin from the folder context menu", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Odepnij" }));
    expect(mutate).toHaveBeenCalledWith({ accountId: 1, folderId: 11 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/mailbox/MailboxRail.test.tsx`
Expected: FAIL (sekcja „Inbox"/„Klienci"/menu nie istnieje jeszcze w komponencie).

- [ ] **Step 3: Write minimal implementation**

In `src/features/mailbox/MailboxRail.tsx`:

(a) Replace the queries import (line 20) with:

```ts
import {
  useAccounts,
  useFolders,
  useLabels,
  useAllAccountFolders,
  usePinnedMap,
  useTogglePinnedFolder,
} from "../../ipc/queries";
```

(b) Replace the bindings type import (line 31) with:

```ts
import type { Account, Folder, SmartFolderKind } from "../../ipc/bindings";
```

(c) Add a new import after the `folder-tree` import block:

```ts
import { selectInboxes, selectPinnedByAccount, isFolderPinned } from "./pinned";
import { RailContextMenu } from "./RailContextMenu";
```

(d) Extend `FolderTreeNodes` to forward a context-menu handler. Update its props type (lines 53-67 area) to add `onFolderContextMenu`:

```tsx
function FolderTreeNodes({
  nodes,
  depth,
  expanded,
  toggle,
  selectedFolderId,
  onFolderClick,
  onFolderContextMenu,
}: {
  nodes: FolderNode[];
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  selectedFolderId: number | null;
  onFolderClick: (folderId: number, accountId: number) => void;
  onFolderContextMenu: (event: React.MouseEvent, folder: Folder) => void;
}) {
```

Add `onContextMenu` to the row `div` (the element with `className={`rail__item...`}`):

```tsx
            <div
              className={`rail__item${isSelected ? " rail__item--active" : ""}`}
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              aria-disabled={node.folder == null ? true : undefined}
              onClick={() => {
                if (hasChildren) toggle(node.fullPath);
                if (node.folder) onFolderClick(node.folder.id, node.folder.account_id);
              }}
              onContextMenu={
                node.folder ? (event) => onFolderContextMenu(event, node.folder!) : undefined
              }
            >
```

Pass `onFolderContextMenu` through the recursive call:

```tsx
              <FolderTreeNodes
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                selectedFolderId={selectedFolderId}
                onFolderClick={onFolderClick}
                onFolderContextMenu={onFolderContextMenu}
              />
```

(e) Inside the `MailboxRail` component body, after the existing data hooks (`const { data: folders = [] } = useFolders(selectedAccountId);`), add:

```tsx
  const foldersByAccount = useAllAccountFolders(accounts);
  const pinnedMap = usePinnedMap().data ?? new Map<number, number[]>();
  const togglePin = useTogglePinnedFolder();
  const inboxEntries = selectInboxes(accounts, foldersByAccount);
  const pinnedGroups = selectPinnedByAccount(accounts, foldersByAccount, pinnedMap);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    folderId: number;
    accountId: number;
    isPinned: boolean;
  } | null>(null);
```

(f) Add the context-menu handler alongside `handleFolderClick`:

```tsx
  function handleFolderContextMenu(event: React.MouseEvent, folder: Folder) {
    if (folder.folder_type === "inbox") return;
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      folderId: folder.id,
      accountId: folder.account_id,
      isPinned: isFolderPinned(pinnedMap, folder.account_id, folder.id),
    });
  }
```

(g) Insert the INBOX and pinned sections at the very top of `<nav className="rail__scroll">`, immediately before `<div className="rail__section">Smart Folders</div>`:

```tsx
        {!accountsLoading && accounts.length > 0 && (
          <>
            <div className="rail__section">Inbox</div>
            {inboxEntries.map(({ account, inbox }) => (
              <div
                key={account.id}
                className={`rail__item${selectedFolderId === inbox.id ? " rail__item--active" : ""}`}
                onClick={() => handleFolderClick(inbox.id, account.id)}
              >
                <Avatar
                  seed={account.email}
                  label={account.display_name || account.email}
                  size={18}
                />
                <span className="rail__item-label">{account.display_name || account.email}</span>
                {inbox.unread_count > 0 && <span className="rail__count">{inbox.unread_count}</span>}
              </div>
            ))}
          </>
        )}
        {pinnedGroups.map(({ account, folders: pinnedFolders }) => (
          <div key={`pinned-${account.id}`}>
            <div className="rail__subsection">{account.display_name || account.email}</div>
            {pinnedFolders.map((folder) => (
              <div
                key={folder.id}
                className={`rail__item${selectedFolderId === folder.id ? " rail__item--active" : ""}`}
                onClick={() => handleFolderClick(folder.id, account.id)}
                onContextMenu={(event) => handleFolderContextMenu(event, folder)}
              >
                <span className="rail__chevron-spacer" />
                <FolderIcon folderType={folder.folder_type} />
                <span className="rail__item-label">{decodeImapUtf7(folder.name)}</span>
                {folder.unread_count > 0 && <span className="rail__count">{folder.unread_count}</span>}
              </div>
            ))}
          </div>
        ))}
```

(h) Pass `onFolderContextMenu={handleFolderContextMenu}` to BOTH existing `FolderTreeNodes` usages in the Accounts section (the `priorityNodes` one and the `restTree` one):

```tsx
                    <FolderTreeNodes
                      nodes={priorityNodes}
                      depth={0}
                      expanded={expanded}
                      toggle={toggle}
                      selectedFolderId={selectedFolderId}
                      onFolderClick={handleFolderClick}
                      onFolderContextMenu={handleFolderContextMenu}
                    />
                    <FolderTreeNodes
                      nodes={restTree}
                      depth={0}
                      expanded={expanded}
                      toggle={toggle}
                      selectedFolderId={selectedFolderId}
                      onFolderClick={handleFolderClick}
                      onFolderContextMenu={handleFolderContextMenu}
                    />
```

(i) Render the menu just before the closing `</aside>` (after `</footer>`):

```tsx
      {menu && (
        <RailContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: menu.isPinned ? "Odepnij" : "Przypnij",
              onClick: () => togglePin.mutate({ accountId: menu.accountId, folderId: menu.folderId }),
            },
          ]}
        />
      )}
```

Append to `src/features/mailbox/MailboxRail.css`:

```css
.rail__subsection {
  padding: 6px 8px 3px 12px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--section-label);
  opacity: 0.8;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/mailbox/MailboxRail.test.tsx`
Expected: PASS (3 tests).

Then run the full suite and type check:

Run: `npx vitest run`
Expected: PASS (all suites).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/mailbox/MailboxRail.tsx src/features/mailbox/MailboxRail.css src/features/mailbox/MailboxRail.test.tsx
git commit -m "feat(rail): inbox section and pinned folders in sidebar"
```

---

## Self-Review Notes

- **Spec coverage:** INBOX section (Task 4 g), pinned groups per account with small header (Task 4 g + `rail__subsection`), persistence in settings (Task 2), context menu pin/unpin (Task 3 + Task 4 f/i), inbox excluded from pinning (Task 1 `selectPinnedByAccount` + Task 4 f guard), alphabetical sort pl (Task 1), all-account folders via useQueries (Task 2), edge cases empty/no-accounts (guards in Task 4 g + `selectPinnedByAccount` returning `[]`). All covered.
- **Type consistency:** `{ accountId, folderId }` mutation shape identical in Task 2, Task 4 test, Task 4 (i). `selectInboxes` returns `{ account, inbox }`, `selectPinnedByAccount` returns `{ account, folders }` — destructured as `folders: pinnedFolders` in render to avoid shadowing the `folders` from `useFolders`. `FolderTreeNodes` gains required `onFolderContextMenu` prop, passed at all three call sites.
- **No placeholders:** every code/test/command step is concrete.
