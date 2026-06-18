# Etap 6-polish — UI fidelity pass (faithful template port) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doprowadzić wygląd shell/rail/list/reader do wiernej zgodności 1:1 z `docs/templates/AbeonMail.html`, odtwarzając strukturę i style szablonu jako komponenty React i wpinając istniejącą logikę (query/mutacje/store/sanitizacja).

**Architecture:** Warstwa prezentacyjna przebudowana wg szablonu (struktura DOM + dokładna paleta/typografia + ikony lucide + drzewo folderów + grupy dat). Logika danych/IPC bez zmian — reużywamy istniejące hooki, mutacje, store (`useUiStore`, `useAppearance` z 6a), sanitizację. Czyste funkcje (folder-tree, grouping) wydzielone i testowane jednostkowo; komponenty zachowują wszystkie istniejące `aria-label`/role i zachowania.

**Tech Stack:** React 19 + TypeScript, zustand, @tanstack/react-virtual, lucide-react (nowa zależność), vitest + @testing-library/react.

## Global Constraints

- Wszystkie identyfikatory w kodzie po angielsku; **bez komentarzy w kodzie** (dokumentacja w `docs/`).
- Commity: Conventional Commits; **bez** współautora; **bez** `git push`.
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`; testy `npm test`; build `npm run build`.
- Pass **frontendowy** — ZERO zmian w Rust/IPC/schema/bindings.
- Źródło prezentacji: `docs/templates/AbeonMail.html` — odtwarzać strukturę i style 1:1 (nie ładować pliku w runtime). Atrapa chrome'u macOS pomijana.
- Logika reużywana, nieusuwana: hooki (`useAccounts`/`useFolders`/`useThreads`/`useSmartFolder`/`useThreadMessages`/`useMessageBody`), mutacje (`useSetFlag`/`useMarkSeen`/`useStartReply`/`useRemoveAccount`/`useReorderAccounts`/`useBeginReauth`), `useUiStore`, `useAppearance`, `MessageBodyView`/`SafeHtmlFrame`.
- Zachować WSZYSTKIE istniejące `aria-label`/role i zachowania (selekcja konta/folderu/wątku, drag-drop reorder, remove-confirm, reauth badge, composer, reply/forward, settings ⚙, motyw/density).
- Placeholdery (Search/Snoozed/LABELS/sort/reader Archive·Snooze·Delete·More): `aria-disabled="true"`, brak `onClick`, wizualnie wyszarzone.
- Paleta i typografia dokładnie wg szablonu (wartości w Task 1).
- Layout: sidebar 264px · lista 360px · reader flex.

---

### Task 1: Tokeny (paleta + typografia 1:1), theme-aware rail, lucide-react, proporcje shell

**Files:**
- Modify: `package.json` (dodać `lucide-react`)
- Modify: `src/shared/theme/tokens.css`
- Modify: `src/app/shell.css`

**Interfaces:**
- Produces: zmienne CSS palety/railu używane przez wszystkie kolejne taski; dostępny `lucide-react`.

- [ ] **Step 1: Zainstaluj lucide-react**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm install lucide-react
```
Expected: `lucide-react` w `dependencies` w `package.json`, instalacja bez błędów.

- [ ] **Step 2: Rozszerz tokeny palety w `tokens.css`**

W bloku `:root { ... }` (sekcja wspólna, po istniejących `--accent*`) dodaj tokeny semantyczne (wartości wspólne — niezależne od motywu) i cień akcentu:

```css
  --accent-violet: #7c3aed;
  --accent-emerald: #10b981;
  --accent-orange: #ef5d3a;
  --shadow-accent: 0 6px 14px -6px rgba(79, 70, 229, 0.6);
  --text-subject: #2a2a40;
  --text-preview: #9090a6;
  --text-count: #a0a0b4;
  --icon-muted: #6b6b85;
  --selection-bg: #eef0fe;
  --section-label: #aaaabf;
  --avatar-account-bg: #e0e7ff;
  --avatar-account-fg: #4338ca;
```

- [ ] **Step 3: Uczyń rail theme-aware w `tokens.css`**

W bloku `:root[data-theme="light"]` zmień `--bg-rail` i `--text-on-rail` oraz dodaj zmienne railu:

```css
  --bg-rail: #f8f8fc;
  --text-on-rail: #1a1a2e;
  --rail-border: #ececf4;
  --rail-item: #55556c;
  --rail-hover: #efeff7;
  --rail-search-bg: #f0f0f6;
  --rail-search-border: #e6e6ee;
```

W bloku `:root[data-theme="dark"]` dodaj odpowiedniki dla ciemnego railu (zachowaj ciemne tło):

```css
  --rail-border: #2a2a40;
  --rail-item: #b4b4c8;
  --rail-hover: #2a2a40;
  --rail-search-bg: #1f1f33;
  --rail-search-border: #2a2a40;
```

(`--bg-rail`/`--text-on-rail` w dark pozostają obecne.)

- [ ] **Step 4: Proporcje 3 kolumn w `shell.css`**

W `shell.css` ustaw kolumny wg szablonu i usuń regułę density-kolumn (density dotyczy tylko listy):

```css
.shell {
  display: grid;
  grid-template-columns: 264px 360px 1fr;
  height: 100%;
}
```

(Jeśli istnieje reguła `.shell[data-density=...] { grid-template-columns... }` — usuń ją; została już usunięta w 6a, potwierdź brak.)

- [ ] **Step 5: Weryfikacja build + tsc**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx tsc --noEmit && npm run build
```
Expected: tsc czysty; vite build OK. (Brak testów jednostkowych — to warstwa tokenów.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/shared/theme/tokens.css src/app/shell.css
git commit -m "feat(ui): add lucide-react, template color/rail tokens, 3-column proportions"
```

---

### Task 2: Drzewo folderów — czysta logika (`folder-tree.ts`)

**Files:**
- Create: `src/features/mailbox/folder-tree.ts`
- Create: `src/features/mailbox/folder-tree.test.ts`

**Interfaces:**
- Consumes: typ `Folder` z `../../ipc/bindings` (pola: `id`, `account_id`, `remote_path`, `name`, `folder_type`, `unread_count`, `total_count`).
- Produces:
  - `recoverDelimiter(remotePath: string, name: string): string | null`
  - `type FolderNode = { segment: string; fullPath: string; folder: Folder | null; children: FolderNode[] }`
  - `buildFolderTree(folders: Folder[]): FolderNode[]`

- [ ] **Step 1: Napisz failing testy**

Create `src/features/mailbox/folder-tree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { recoverDelimiter, buildFolderTree } from "./folder-tree";
import type { Folder } from "../../ipc/bindings";

function f(id: number, remote_path: string, name: string): Folder {
  return {
    id,
    account_id: 1,
    remote_path,
    name,
    folder_type: "custom",
    unread_count: 0,
    total_count: 0,
  } as Folder;
}

describe("recoverDelimiter", () => {
  it("returns the char before the leaf name", () => {
    expect(recoverDelimiter("Archives.2023", "2023")).toBe(".");
    expect(recoverDelimiter("Work/Clients", "Clients")).toBe("/");
  });
  it("returns null for a root folder (path equals name)", () => {
    expect(recoverDelimiter("Junk", "Junk")).toBeNull();
  });
});

describe("buildFolderTree", () => {
  it("keeps flat folders as roots", () => {
    const tree = buildFolderTree([f(1, "Junk", "Junk"), f(2, "Archive", "Archive")]);
    expect(tree.map((n) => n.segment)).toEqual(["Junk", "Archive"]);
    expect(tree[0].folder?.id).toBe(1);
    expect(tree[0].children).toEqual([]);
  });

  it("nests children under a real parent", () => {
    const tree = buildFolderTree([
      f(1, "Archives", "Archives"),
      f(2, "Archives.2023", "2023"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].folder?.id).toBe(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].folder?.id).toBe(2);
    expect(tree[0].children[0].segment).toBe("2023");
  });

  it("creates a virtual container when the parent has no real folder", () => {
    const tree = buildFolderTree([
      f(2, "Klienci_Sm.eGniazdko", "eGniazdko"),
      f(3, "Klienci_Sm.mmRental", "mmRental"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].segment).toBe("Klienci_Sm");
    expect(tree[0].folder).toBeNull();
    expect(tree[0].children.map((c) => c.segment).sort()).toEqual(["eGniazdko", "mmRental"]);
  });
});
```

- [ ] **Step 2: Uruchom — fail**

Run: `npm test -- src/features/mailbox/folder-tree.test.ts`
Expected: FAIL ("Cannot find module './folder-tree'").

- [ ] **Step 3: Zaimplementuj `folder-tree.ts`**

Create `src/features/mailbox/folder-tree.ts`:

```ts
import type { Folder } from "../../ipc/bindings";

export type FolderNode = {
  segment: string;
  fullPath: string;
  folder: Folder | null;
  children: FolderNode[];
};

export function recoverDelimiter(remotePath: string, name: string): string | null {
  if (remotePath.length <= name.length) return null;
  if (!remotePath.endsWith(name)) return null;
  return remotePath[remotePath.length - name.length - 1];
}

export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();

  function ensureNode(fullPath: string, segment: string, parent: FolderNode | null): FolderNode {
    const existing = byPath.get(fullPath);
    if (existing) return existing;
    const node: FolderNode = { segment, fullPath, folder: null, children: [] };
    byPath.set(fullPath, node);
    if (parent) parent.children.push(node);
    else roots.push(node);
    return node;
  }

  for (const folder of folders) {
    const delim = recoverDelimiter(folder.remote_path, folder.name);
    if (delim === null) {
      const node = ensureNode(folder.remote_path, folder.name, null);
      node.folder = folder;
      continue;
    }
    const segments = folder.remote_path.split(delim);
    let parent: FolderNode | null = null;
    let accPath = "";
    for (let i = 0; i < segments.length; i += 1) {
      accPath = i === 0 ? segments[0] : accPath + delim + segments[i];
      const node = ensureNode(accPath, segments[i], parent);
      parent = node;
    }
    if (parent) parent.folder = folder;
  }

  return roots;
}
```

- [ ] **Step 4: Uruchom — pass**

Run: `npm test -- src/features/mailbox/folder-tree.test.ts`
Expected: PASS (5 testów).

- [ ] **Step 5: Commit**

```bash
git add src/features/mailbox/folder-tree.ts src/features/mailbox/folder-tree.test.ts
git commit -m "feat(ui): folder-tree builder (recover IMAP delimiter, nest by path)"
```

---

### Task 3: Grupowanie dat listy — czysta logika (`grouping.ts`)

**Files:**
- Create: `src/features/message-list/grouping.ts`
- Create: `src/features/message-list/grouping.test.ts`

**Interfaces:**
- Produces:
  - `groupLabel(epochSeconds: number, nowSeconds: number): "Today" | "Yesterday" | "Earlier"`
  - `type ListEntry<T> = { kind: "header"; label: string } | { kind: "item"; data: T }`
  - `groupIntoEntries<T>(items: T[], getDate: (item: T) => number, nowSeconds: number): ListEntry<T>[]`

- [ ] **Step 1: Napisz failing testy**

Create `src/features/message-list/grouping.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupLabel, groupIntoEntries } from "./grouping";

const NOON_TODAY = Math.floor(new Date(2026, 5, 18, 12, 0, 0).getTime() / 1000);

describe("groupLabel", () => {
  it("labels same calendar day as Today", () => {
    const morning = Math.floor(new Date(2026, 5, 18, 8, 0, 0).getTime() / 1000);
    expect(groupLabel(morning, NOON_TODAY)).toBe("Today");
  });
  it("labels previous calendar day as Yesterday", () => {
    const y = Math.floor(new Date(2026, 5, 17, 23, 0, 0).getTime() / 1000);
    expect(groupLabel(y, NOON_TODAY)).toBe("Yesterday");
  });
  it("labels older as Earlier", () => {
    const old = Math.floor(new Date(2026, 5, 10, 12, 0, 0).getTime() / 1000);
    expect(groupLabel(old, NOON_TODAY)).toBe("Earlier");
  });
});

describe("groupIntoEntries", () => {
  it("inserts a header before each new group, items keep order", () => {
    const items = [
      { id: 1, d: Math.floor(new Date(2026, 5, 18, 9).getTime() / 1000) },
      { id: 2, d: Math.floor(new Date(2026, 5, 17, 9).getTime() / 1000) },
      { id: 3, d: Math.floor(new Date(2026, 5, 1, 9).getTime() / 1000) },
    ];
    const entries = groupIntoEntries(items, (i) => i.d, NOON_TODAY);
    expect(entries).toEqual([
      { kind: "header", label: "Today" },
      { kind: "item", data: items[0] },
      { kind: "header", label: "Yesterday" },
      { kind: "item", data: items[1] },
      { kind: "header", label: "Earlier" },
      { kind: "item", data: items[2] },
    ]);
  });
  it("emits no header for an empty list", () => {
    expect(groupIntoEntries([], () => 0, NOON_TODAY)).toEqual([]);
  });
});
```

- [ ] **Step 2: Uruchom — fail**

Run: `npm test -- src/features/message-list/grouping.test.ts`
Expected: FAIL ("Cannot find module './grouping'").

- [ ] **Step 3: Zaimplementuj `grouping.ts`**

Create `src/features/message-list/grouping.ts`:

```ts
export type GroupLabel = "Today" | "Yesterday" | "Earlier";

export type ListEntry<T> =
  | { kind: "header"; label: GroupLabel }
  | { kind: "item"; data: T };

function startOfDay(epochSeconds: number): number {
  const d = new Date(epochSeconds * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function groupLabel(epochSeconds: number, nowSeconds: number): GroupLabel {
  const today = startOfDay(nowSeconds);
  const day = startOfDay(epochSeconds);
  const oneDay = 86400;
  if (day >= today) return "Today";
  if (day >= today - oneDay) return "Yesterday";
  return "Earlier";
}

export function groupIntoEntries<T>(
  items: T[],
  getDate: (item: T) => number,
  nowSeconds: number
): ListEntry<T>[] {
  const entries: ListEntry<T>[] = [];
  let current: GroupLabel | null = null;
  for (const item of items) {
    const label = groupLabel(getDate(item), nowSeconds);
    if (label !== current) {
      entries.push({ kind: "header", label });
      current = label;
    }
    entries.push({ kind: "item", data: item });
  }
  return entries;
}
```

- [ ] **Step 4: Uruchom — pass**

Run: `npm test -- src/features/message-list/grouping.test.ts`
Expected: PASS (5 testów).

- [ ] **Step 5: Commit**

```bash
git add src/features/message-list/grouping.ts src/features/message-list/grouping.test.ts
git commit -m "feat(ui): date-group helper for message list (Today/Yesterday/Earlier)"
```

---

### Task 4: MailboxRail — wierny port struktury (header, search, sekcje z ikonami, drzewo, footer)

**Files:**
- Modify: `src/features/mailbox/MailboxRail.tsx` (przebudowa renderu; ZACHOWAĆ logikę)
- Create: `src/features/mailbox/MailboxRail.css`
- Modify: `src/features/mailbox/MailboxRail.test.tsx`

**Interfaces:**
- Consumes: `buildFolderTree`/`FolderNode` (Task 2); `Avatar` z `../../shared/appearance/Avatar`; ikony z `lucide-react`; istniejące hooki/mutacje/store.
- Produces: brak nowych eksportów (komponent).

**ZACHOWAĆ (logika i a11y — przenieść do nowej struktury, nie usuwać):**
- Stan/handlery: `wizardOpen`, `confirmAccount`, selektory store (`selectedAccountId/FolderId/SmartFolder`, `setSelected*`, `openSettings`), `useAccounts/useFolders/useRemoveAccount/useBeginReauth/useReorderAccounts`, `handleAccountClick/handleFolderClick/handleAdded/handleRemoveClick/handleRemoveConfirm/handleRemoveCancel/handleReauthClick/handleDragEnd`, `DndContext/SortableContext/useSensor(PointerSensor)`.
- `aria-label`: drag handle `Drag to reorder <acct>`, reauth `Reconnect account <acct>`, remove `Remove account <acct>`, `Open settings`, `Cancel`/`Confirm` w dialogu remove.
- Smart foldery klikalne: All Inboxes (`all_inboxes`), Unread (`unread`), Flagged (`flagged`) → `setSelectedSmartFolder`.

**Struktura docelowa (port z `docs/templates/AbeonMail.html`, klasy CSS w `MailboxRail.css`):**
`aside.rail` > `header.rail__header` (logo-badge „A" `.rail__logo` + „AbeonMail" `.rail__title` + `Avatar` konta) · `.rail__search` (placeholder: ikona `Search` + „Search", `aria-disabled`, bez handlera) · `nav.rail__scroll` zawierający:
- sekcja SMART FOLDERS: `.rail__section` nagłówek + pozycje `.rail__item` (ikona + label + `.rail__count`): All Inboxes (`Layers`), Unread (`MailOpen`), Flagged (`Flag`) — klikalne; Snoozed (`Clock`) — `aria-disabled`, bez handlera.
- sekcja ACCOUNTS: dla każdego konta (DndContext zachowany) wiersz konta (`Avatar` + nazwa + reauth/remove jak dziś) i — gdy konto wybrane — **drzewo folderów** przez `<FolderTreeNodes nodes={buildFolderTree(folders)} .../>`.
- sekcja LABELS: nagłówek `.rail__section` + `.rail__placeholder` „Coming soon" (`aria-disabled`).
- `footer.rail__footer`: „Add account" (zachowany onClick `setWizardOpen(true)`) + ⚙ (ikona `Settings`, `aria-label="Open settings"`, `onClick={openSettings}`).
- Dialogi (`AddAccountWizard`, `RemoveConfirmDialog`) bez zmian funkcjonalnych (mogą zostać na inline-style).

**Render drzewa** — wewnętrzny komponent w pliku:
```tsx
function FolderTreeNodes({
  nodes,
  depth,
  expanded,
  toggle,
  selectedFolderId,
  onFolderClick,
}: {
  nodes: FolderNode[];
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  selectedFolderId: number | null;
  onFolderClick: (folderId: number, accountId: number) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isOpen = expanded.has(node.fullPath);
        const isSelected = node.folder != null && selectedFolderId === node.folder.id;
        return (
          <div key={node.fullPath}>
            <div
              className={`rail__item rail__folder${isSelected ? " rail__item--active" : ""}`}
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              aria-disabled={node.folder == null ? true : undefined}
              onClick={() => {
                if (hasChildren) toggle(node.fullPath);
                if (node.folder) onFolderClick(node.folder.id, node.folder.account_id);
              }}
            >
              {hasChildren ? (
                isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
              ) : (
                <span className="rail__chevron-spacer" />
              )}
              <FolderIcon folderType={node.folder?.folder_type} />
              <span className="rail__item-label">{node.segment}</span>
              {node.folder != null && node.folder.unread_count > 0 && (
                <span className="rail__count">{node.folder.unread_count}</span>
              )}
            </div>
            {hasChildren && isOpen && (
              <FolderTreeNodes
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                selectedFolderId={selectedFolderId}
                onFolderClick={onFolderClick}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
```
Stan rozwinięcia: `const [expanded, setExpanded] = useState<Set<string>>(new Set())`; `toggle(path)` tworzy nowy `Set`. Domyślnie korzenie rozwinięte (zainicjuj `expanded` ścieżkami korzeni przy pierwszym renderze folderów wybranego konta — `useEffect` na `folders`).

**Mapowanie ikon folder-type** — wewnętrzny `FolderIcon`:
```tsx
import { Inbox, Send, FileText, Archive, ShieldAlert, Trash2, Folder } from "lucide-react";
function FolderIcon({ folderType }: { folderType?: string }) {
  const Icon =
    folderType === "inbox" ? Inbox :
    folderType === "sent" ? Send :
    folderType === "drafts" ? FileText :
    folderType === "archive" ? Archive :
    folderType === "spam" ? ShieldAlert :
    folderType === "trash" ? Trash2 :
    Folder;
  return <Icon size={15} className="rail__item-icon" />;
}
```

- [ ] **Step 1: Zaktualizuj testy (failing) pod nową strukturę**

Modify `src/features/mailbox/MailboxRail.test.tsx` — zachowaj istniejące mocki i asercje zachowań; dodaj/dostosuj asercje:
```tsx
it("smart folders remain clickable and select the smart folder", () => {
  // render z mockiem useAccounts/useFolders jak obecnie; klik "All Inboxes" -> setSelectedSmartFolder("all_inboxes")
});
it("Search and Snoozed and LABELS are non-interactive placeholders", () => {
  // getByText("Search") closest [aria-disabled="true"]; "Snoozed" aria-disabled; "Coming soon" present
});
it("Open settings button calls openSettings", () => {
  // istniejąca asercja zachowana
});
```
Dostosuj istniejące asercje (selektory wg nowych klas/struktury) tak, by sprawdzały zachowania, nie dawny markup. Uruchom i potwierdź, że nowe/zmienione asercje failują przed implementacją.

Run: `npm test -- src/features/mailbox/MailboxRail.test.tsx`
Expected: FAIL (nowe asercje, brak struktury/klas).

- [ ] **Step 2: Utwórz `MailboxRail.css`**

Create `src/features/mailbox/MailboxRail.css` (wartości z szablonu):
```css
.rail {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-rail);
  color: var(--text-on-rail);
  border-right: 1px solid var(--rail-border);
}
.rail__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 16px 12px;
  flex-shrink: 0;
}
.rail__logo {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 16px;
}
.rail__title {
  flex: 1;
  font-weight: 800;
  font-size: 15px;
  letter-spacing: -0.01em;
  color: var(--text-on-rail);
}
.rail__search {
  margin: 4px 14px 12px;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  background: var(--rail-search-bg);
  border: 1px solid var(--rail-search-border);
  border-radius: 10px;
  color: #9a9ab0;
  font-size: 13px;
  flex-shrink: 0;
}
.rail__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 2px 12px 16px;
}
.rail__section {
  padding: 8px 8px 5px;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--section-label);
}
.rail__item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 12px;
  border-radius: 9px;
  color: var(--rail-item);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.rail__item:hover {
  background: var(--rail-hover);
}
.rail__item--active {
  color: var(--accent);
  background: var(--rail-hover);
}
.rail__item[aria-disabled="true"] {
  opacity: 0.45;
  cursor: default;
}
.rail__item[aria-disabled="true"]:hover {
  background: transparent;
}
.rail__item-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rail__item-icon {
  flex-shrink: 0;
  color: var(--icon-muted);
}
.rail__count {
  font-size: 11.5px;
  color: var(--rail-count);
  font-weight: 700;
}
.rail__chevron-spacer {
  width: 14px;
  flex-shrink: 0;
}
.rail__placeholder {
  padding: 7px 12px;
  font-size: 12px;
  color: var(--section-label);
  opacity: 0.7;
}
.rail__footer {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--rail-border);
  flex-shrink: 0;
}
.rail__compose,
.rail__add {
  flex: 1;
  height: 36px;
  border: none;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-family: inherit;
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
}
.rail__settings {
  width: 36px;
  border: 1px solid var(--rail-border);
  border-radius: 9px;
  background: transparent;
  color: var(--rail-item);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rail__account-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 12px;
  border-radius: 9px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--rail-item);
}
.rail__account-row--active {
  color: var(--accent);
}
```

- [ ] **Step 3: Przebuduj `MailboxRail.tsx`**

Przebuduj render `MailboxRail` do struktury docelowej (wyżej), importując ikony z `lucide-react` (`Search, Layers, MailOpen, Flag, Clock, Settings, ChevronRight, ChevronDown, Inbox, Send, FileText, Archive, ShieldAlert, Trash2, Folder`), `Avatar` z `../../shared/appearance/Avatar`, `buildFolderTree`/`FolderNode` z `./folder-tree`, oraz `"./MailboxRail.css"`. ZACHOWAJ całą logikę z listy „ZACHOWAĆ" (stan, handlery, dnd, dialogi, aria-label). Dodaj `FolderTreeNodes` i `FolderIcon` jako wewnętrzne komponenty. Drzewo renderuj zamiast obecnej płaskiej listy folderów (która była dzieckiem `SortableAccountRow` dla wybranego konta). Smart foldery i Snoozed wg struktury. Search/LABELS jako placeholdery `aria-disabled`. Footer: Add account + ⚙. Usuń inline-style na rzecz klas.

Avatar konta w headerze: `const headerAccount = accounts.find((a) => a.id === selectedAccountId) ?? accounts[0]`; `{headerAccount && <Avatar seed={headerAccount.email} label={headerAccount.display_name || headerAccount.email} size={30} />}`.

- [ ] **Step 4: Uruchom testy railu — pass**

Run: `npm test -- src/features/mailbox/MailboxRail.test.tsx`
Expected: PASS.

- [ ] **Step 5: tsc + pełny zestaw**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"; npx tsc --noEmit && npm test`
Expected: tsc czysty; wszystkie testy zielone.

- [ ] **Step 6: Commit**

```bash
git add src/features/mailbox/MailboxRail.tsx src/features/mailbox/MailboxRail.css src/features/mailbox/MailboxRail.test.tsx
git commit -m "feat(ui): rebuild MailboxRail to template (light rail, icons, folder tree, placeholders)"
```

---

### Task 5: MessageListPane — nagłówek (Compose+sort), grupy dat, wiersze wg szablonu

**Files:**
- Modify: `src/features/message-list/MessageListPane.tsx`
- Modify: `src/features/message-list/MessageListPane.css`
- Modify: `src/app/AppShell.tsx` (usunąć pływający przycisk „New" — przeniesiony do nagłówka listy)
- Modify: `src/features/message-list/MessageListPane.test.tsx`
- Modify: `src/app/AppShell.test.tsx` (jeśli asercja na „New message" dotyczyła pływającego przycisku — patrz Step 1)

**Interfaces:**
- Consumes: `groupIntoEntries`/`ListEntry` (Task 3); ikony `PencilLine`, `ChevronDown` z `lucide-react`; istniejące hooki/store/`Avatar`.

**ZACHOWAĆ:** wirtualizacja (`useVirtualizer`), tryb wątkowy vs smart (`isSmartMode`, `useThreads`/`useSmartFolder`), selekcja (`setSelectedThreadId`/`setSelectedMessageId`), unread dot, badge'e (flag/count/attachment), kropka koloru konta (smart), avatar (z 6a), `showPreview`/`showAvatars`/`density` ze store, `showSnippet = showPreview && density !== "dense"`. Compose `aria-label="New message"` (przeniesiony z AppShell) wywołuje `openComposer(null)`.

- [ ] **Step 1: Zaktualizuj testy (failing)**

Modify `src/features/message-list/MessageListPane.test.tsx` — dodaj asercje:
```tsx
it("renders date group headers", () => {
  // mock useThreads z wątkami o różnych datach (today/yesterday/older) -> getByText("Today"), "Yesterday", "Earlier"
});
it("Compose button in list header opens composer", () => {
  // getByRole("button", { name: "New message" }) klik -> openComposer wywołany
});
it("sort label is a non-interactive placeholder", () => {
  // getByText("Newest") closest [aria-disabled="true"]
});
```
Jeśli `AppShell.test.tsx` ma asercję „renders New message button" wskazującą pływający przycisk — przenieś ją (przycisk żyje teraz w `MessageListPane`); w `AppShell.test` usuń tę asercję (AppShell nie renderuje już „New").

Run: `npm test -- src/features/message-list/MessageListPane.test.tsx`
Expected: FAIL (brak nagłówka/Compose/grup).

- [ ] **Step 2: Przebuduj render `MessageListPane.tsx`**

Dodaj import `groupIntoEntries`, `ListEntry` z `./grouping`, ikony `PencilLine`, `ChevronDown`. Nad listą dodaj nagłówek kolumny:
```tsx
const openComposer = useUiStore((s) => s.openComposer);
// ...
<div className="message-list__header">
  <button type="button" className="message-list__compose" aria-label="New message" onClick={() => openComposer(null)}>
    <PencilLine size={15} /> Compose
  </button>
  <span className="message-list__sort" aria-disabled="true">
    Newest <ChevronDown size={13} />
  </span>
</div>
```
Zbuduj wpisy z nagłówkami dat (dla obu trybów). Data: tryb wątkowy `thread.last_date`, smart `row.date`. `nowSeconds = Math.floor(Date.now() / 1000)`:
```tsx
const HEADER_HEIGHT = 28;
const entries: ListEntry<ThreadSummary | SmartMessageRow> = ... // groupIntoEntries(items, getDate, nowSeconds)
```
Wirtualizer: `count: entries.length`, `estimateSize: (i) => entries[i].kind === "header" ? HEADER_HEIGHT : rowHeight`. W renderze pozycji: jeśli `entry.kind === "header"` renderuj `<div className="message-list__group">{entry.label}</div>`; w przeciwnym razie renderuj `ThreadRow`/`SmartRow` jak obecnie (z istniejącymi propsami `showAvatars`/`showSnippet`/selekcja). Zachowaj `position:absolute` + `top: virtualItem.start`.

Usuń z `MessageListPane` nic z logiki danych — tylko struktura renderu się zmienia.

- [ ] **Step 3: Usuń pływający „New" z `AppShell.tsx`**

Modify `src/app/AppShell.tsx`: usuń blok `<div className="shell-compose-action"> ... New ... </div>` (Compose żyje teraz w nagłówku listy). Pozostaw resztę (panes, settings overlay, composer) bez zmian.

- [ ] **Step 4: Styl nagłówka i grup w `MessageListPane.css`**

Dopisz do `MessageListPane.css`:
```css
.message-list__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.message-list__compose {
  height: 36px;
  padding: 0 16px;
  border: none;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-family: inherit;
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  box-shadow: var(--shadow-accent);
}
.message-list__sort {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 600;
}
.message-list__group {
  padding: 12px 18px 6px;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--section-label);
}
.message-row--selected {
  background: var(--selection-bg);
  border-left: 3px solid var(--accent);
}
.message-row__subject {
  color: var(--text-subject);
}
.message-row__snippet {
  color: var(--text-preview);
}
```
(Jeśli istnieją wcześniejsze reguły `.message-row--selected`/`__subject`/`__snippet`, zaktualizuj je do powyższych wartości zamiast duplikować.)

- [ ] **Step 5: Uruchom testy listy + AppShell — pass**

Run: `npm test -- src/features/message-list/MessageListPane.test.tsx src/app/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 6: tsc + pełny zestaw**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"; npx tsc --noEmit && npm test`
Expected: czysto + zielone.

- [ ] **Step 7: Commit**

```bash
git add src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.css src/features/message-list/MessageListPane.test.tsx src/app/AppShell.tsx src/app/AppShell.test.tsx
git commit -m "feat(ui): message list header (compose+sort), date groups, template row styling"
```

---

### Task 6: ConversationView — toolbar, body 840px, nadawca, box odpowiedzi

**Files:**
- Modify: `src/features/reader/ConversationView.tsx`
- Modify: `src/features/reader/reader.css`
- Modify: `src/features/reader/ConversationView.test.tsx`

**Interfaces:**
- Consumes: ikony `Reply, ReplyAll, Forward, Star, Archive, Clock, Trash2, MoreHorizontal, SendHorizontal, Paperclip` z `lucide-react`; `Avatar`; istniejące `useThreadMessages`/`useStartReply`/`useSetFlag`/`useUiStore`/`MessageBodyView`.

**ZACHOWAĆ:** `useThreadMessages(threadId)`, stany loading/empty, `handleReply("reply"|"reply_all"|"forward")` (`startReply`→`openComposer`), per-message `MessageBodyView`. `aria-label` Reply/Reply all/Forward zachowane (na przyciskach-ikonach).

**Nowa struktura (port z szablonu):**
- `div.reader` > `div.reader__toolbar` (sticky) z przyciskami-ikonami 36px (`.reader__icon`):
  - placeholdery (`aria-disabled`, bez onClick): `Archive` (Archive), `Clock` (Snooze), `Trash2` (Delete), divider `.reader__divider`, … na końcu `MoreHorizontal` (More).
  - funkcjonalne: `Reply`/`ReplyAll`/`Forward` (aria-label „Reply"/„Reply all"/„Forward", onClick `handleReply(...)` dla głównej wiadomości = ostatnia w wątku).
- `div.reader__body` (`flex:1; padding:30px 44px; overflow:auto`) > `div.reader__inner` (`max-width:840px; margin:0 auto`):
  - nagłówek: `h2.reader__subject` (subject pierwszej/ostatniej wiadomości) + `Star` (`button.reader__star`, `aria-label="Flag"`, toggle flagi ostatniej wiadomości przez `useSetFlag`).
  - dla każdej wiadomości wątku: blok `.reader__message` z `Avatar size={46}` + nazwa + „to …" + czas, oraz `MessageBodyView messageId={m.id}`.
- `div.reader__reply` (dół): `button.reader__reply-trigger` „Reply to <nadawca>…" (onClick `handleReply("reply")`) + `button.reader__send` (ikona `SendHorizontal` „Send", onClick `handleReply("reply")`).

Star/flaga: `const setFlag = useSetFlag();`. Sygnatura mutacji (z `src/ipc/queries.ts`): `setFlag.mutate({ messageId, flag, value })`, gdzie `flag: MessageFlag` i `value: boolean`. Główna wiadomość `const last = messages[messages.length - 1]`. Star onClick: `setFlag.mutate({ messageId: last.id, flag: "flagged", value: !last.flagged })`. Klasa gwiazdki `reader__star--on` gdy `last.flagged`.

- [ ] **Step 1: Zaktualizuj testy (failing)**

Modify `src/features/reader/ConversationView.test.tsx` — zachowaj mocki; zachowaj/dostosuj asercje Reply/Reply all/Forward (teraz przyciski-ikony z tym samym `aria-label`), dodaj:
```tsx
it("Star toggles the flag on the latest message", () => {
  // klik getByRole("button", { name: "Flag" }) -> setFlag wywołany z id ostatniej wiadomości i flagged=!current
});
it("reader toolbar Archive/Snooze/Delete/More are disabled placeholders", () => {
  // getByRole("button", { name: "Archive" }) ma aria-disabled; itd.
});
it("bottom reply trigger starts a reply", () => {
  // klik getByRole("button", { name: /Reply to/ }) -> startReply mode "reply"
});
```
Sprawdź sygnaturę `useSetFlag` w `src/ipc/queries.ts` i odwzoruj ją w mocku testu.

Run: `npm test -- src/features/reader/ConversationView.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Przebuduj `ConversationView.tsx`**

Przepisz `ConversationView` wg struktury docelowej. Toolbar i subject/star na poziomie konwersacji (nie per-message); body mapuje wiadomości (`messages.map`) renderując nadawcę (Avatar 46px) + `MessageBodyView`. Główna wiadomość do reply/star = ostatnia. Importy ikon + `Avatar` + `"./reader.css"`. Placeholdery `aria-disabled` bez onClick. Zachowaj `aria-label` „Reply"/„Reply all"/„Forward".

- [ ] **Step 3: Styl readera w `reader.css`**

Zastąp/uzupełnij `reader.css` (zachowaj istniejące reguły dla `MessageBodyView`/iframe, jeśli są):
```css
.reader {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.reader__toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.reader__icon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  border: none;
  background: transparent;
  color: var(--icon-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.reader__icon:hover {
  background: var(--bg-app);
  color: var(--accent);
}
.reader__icon[aria-disabled="true"] {
  opacity: 0.45;
  cursor: default;
}
.reader__icon[aria-disabled="true"]:hover {
  background: transparent;
  color: var(--icon-muted);
}
.reader__divider {
  width: 1px;
  height: 20px;
  background: var(--border-subtle);
  margin: 0 8px;
}
.reader__spacer {
  flex: 1;
}
.reader__body {
  flex: 1;
  padding: 30px 44px;
  overflow-y: auto;
}
.reader__inner {
  max-width: 840px;
  margin: 0 auto;
}
.reader__subject {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.01em;
  line-height: 1.25;
  margin: 0;
  color: var(--text-primary);
}
.reader__subject-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.reader__star {
  border: none;
  background: transparent;
  color: #c4c4d4;
  cursor: pointer;
  flex-shrink: 0;
}
.reader__star--on {
  color: var(--accent);
}
.reader__message {
  margin-top: 22px;
}
.reader__sender {
  display: flex;
  align-items: center;
  gap: 13px;
}
.reader__sender-name {
  font-weight: 700;
  font-size: 15px;
  color: var(--text-primary);
}
.reader__reply {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 24px;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.reader__reply-trigger {
  flex: 1;
  text-align: left;
  height: 40px;
  padding: 0 14px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}
.reader__send {
  height: 40px;
  padding: 0 16px;
  border: none;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-family: inherit;
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
```

- [ ] **Step 4: Uruchom testy readera — pass**

Run: `npm test -- src/features/reader/ConversationView.test.tsx`
Expected: PASS.

- [ ] **Step 5: tsc + pełny zestaw**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"; npx tsc --noEmit && npm test`
Expected: czysto + zielone.

- [ ] **Step 6: Commit**

```bash
git add src/features/reader/ConversationView.tsx src/features/reader/reader.css src/features/reader/ConversationView.test.tsx
git commit -m "feat(ui): rebuild reader to template (icon toolbar, centered body, reply box)"
```

---

### Task 7: Weryfikacja end-to-end + fidelity check 1:1

**Files:** brak nowych — krok integracyjny i weryfikacyjny.

- [ ] **Step 1: Pełny build + testy**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx tsc --noEmit && npm test && npm run build
```
Expected: tsc czysty; wszystkie testy zielone; vite build OK.

- [ ] **Step 2: Fidelity check (uruchomienie aplikacji) — wykonuje kontroler/użytkownik**

Uruchom `npm run tauri dev` (DISPLAY=:1). Porównaj 1:1 z `docs/templates/AbeonMail.html` (i ze zrzutem szablonu):
1. Rail jasny (light), logo „A" + tytuł + avatar konta; Search-box; SMART FOLDERS z ikonami + Snoozed wyszarzony; konta z avatarami; **drzewo folderów** rozwijalne (chevrony, wcięcia, liczniki); LABELS „Coming soon"; footer Add account + ⚙.
2. Nagłówek listy: Compose (indigo, pencil) + „Newest". Nagłówki grup dat. Wiersze: avatar, nazwa/czas/subject/preview, zaznaczenie `#eef0fe` + lewy pasek.
3. Reader: toolbar ikon (Reply/Reply all/Forward działają, Star flaguje, reszta wyszarzona), body 840px wyśrodkowane, subject 24px, nadawca 46px, box „Reply to …" + Send.
4. Motyw dark (z 6a): rail ciemny; przełączanie działa.
5. Typografia/paleta zgodne z szablonem (wagi 600/700/800, kolory).

Kryterium: wygląd i zachowanie zgodne z szablonem; istniejące funkcje (selekcja, drag-drop, composer, reply, settings, motyw/density) działają.

- [ ] **Step 3: Commit (jeśli drobne korekty po fidelity check)**

```bash
git add -A
git commit -m "fix(ui): fidelity adjustments after template comparison"
```
(Pomiń, jeśli brak korekt.)

---

## Self-Review

**Spec coverage:**
- Tokeny: paleta + typografia 1:1 + theme-aware rail + lucide-react → Task 1. ✓
- Wierny port struktury (logika reużywana, aria zachowane) → Task 4/5/6 (listy „ZACHOWAĆ"). ✓
- Ikony wiodące → Task 1 (dep) + Task 4/5/6 (użycie). ✓
- Drzewo folderów → Task 2 (logika) + Task 4 (render). ✓
- Grupy dat w wirtualizerze → Task 3 (logika) + Task 5 (render). ✓
- Reader toolbar (wpięte + atrapy), body 840px, box odpowiedzi, Star→flaga → Task 6. ✓
- Compose w nagłówku listy (przeniesiony z AppShell) → Task 5. ✓
- Placeholdery aria-disabled (Search/Snoozed/LABELS/sort/reader) → Task 4/5/6. ✓
- Brak zmian backendu → potwierdzone (tylko frontend). ✓
- Fidelity check 1:1 → Task 7. ✓

**Placeholder scan:** Kod czysty (pełny) dla logiki (folder-tree, grouping) i CSS. Komponenty rail/list/reader opisane strukturą docelową + dokładnymi klasami/ikonami/wiringiem + listą „ZACHOWAĆ" + dokładnymi asercjami testów; implementer czyta bieżący plik + `docs/templates/AbeonMail.html`. Brak „TBD/TODO".

**Type consistency:** `FolderNode`/`buildFolderTree`/`recoverDelimiter` (Task 2) spójne z użyciem w Task 4. `ListEntry`/`groupIntoEntries`/`groupLabel` (Task 3) spójne z Task 5. Nazwy klas CSS (`rail__*`, `message-list__*`, `reader__*`) spójne między CSS a komponentami. Ikony lucide-react jednolite. `useSetFlag` — sygnaturę zweryfikować w Task 6 Step 1 (z `src/ipc/queries.ts`) i odwzorować w teście.

## Execution Handoff

Patrz wiadomość po zapisaniu planu.
