# Mark as read — timing setting + manual control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable "mark messages as read" timing setting (immediate / after a delay / never) plus a discoverable manual read/unread control, with auto-mark applying to the whole open conversation.

**Architecture:** Frontend-only, built on the existing V6 `settings` key/value store (extending the Etap 7c General domain) and the existing `set_message_flags(id, "seen", bool)` Tauri command. Auto-mark logic moves from `MessageBodyView` (per-message) into `ConversationView` (whole conversation, mode-gated, once-per-open). A shared `useSetSeen` mutation plus a pure `seenIdsForBulk` helper drive the reader toolbar toggle, the list multi-select buttons, and the `Shift+I`/`Shift+U` shortcuts.

**Tech Stack:** React + TypeScript, Zustand store, TanStack Query, Vitest + @testing-library/react, lucide-react icons (stubbed in tests).

## Global Constraints

- Frontend-only: NO Rust changes, NO new SQL migration, NO `npm run gen:bindings`. Reuse command `set_message_flags`.
- No code comments in source (project rule). All identifiers in English.
- `tsconfig` has `noUnusedLocals`/`noUnusedParameters` ON — unused imports/locals break `npm run build` even though Vitest stays green. Always finish a task with `npm run build`.
- When `UiState` (in `src/app/store.ts`) gains a field, the typed `const state: UiState` literal in `src/features/message-list/MessageListPane.test.tsx` MUST be extended in the same task or `tsc` fails (TS2741).
- New lucide icons MUST be added to `src/test/lucide-stub.js` or tests OOM. (`MailOpen` is already present; only `Mail` is new.)
- Settings live under the `general.*` key namespace; General store field names are identical to `GeneralFields` keys so `hydrateGeneral`'s spread maps them correctly (unlike the prefixed snooze fields).
- Run focused tests with `npx vitest run <path>`; full suite with `npx vitest run`; production typecheck/build with `npm run build`. Node ≥ 24 (`$HOME/.nvm/versions/node/v24.14.0/bin`).
- Commits: Conventional Commits, no co-author line.

---

### Task 1: General settings data layer (keys, types, defaults, parse)

**Files:**
- Modify: `src/shared/general/general.ts`
- Test: `src/shared/general/general.test.ts`

**Interfaces:**
- Produces: `type MarkReadMode = "immediate" | "delay" | "never"`; `GENERAL_KEYS.markReadMode = "general.markReadMode"`, `GENERAL_KEYS.markReadDelaySeconds = "general.markReadDelaySeconds"`; `DEFAULT_GENERAL.markReadMode = "immediate"`, `DEFAULT_GENERAL.markReadDelaySeconds = 2`; `MARK_READ_MODES: { value: MarkReadMode; label: string }[]`; `parseGeneralSettings` now reads the two new keys.

- [ ] **Step 1: Write the failing tests**

In `src/shared/general/general.test.ts`, update the defaults test and add new cases inside `describe("parseGeneralSettings", ...)`:

```ts
  it("whitelists markReadMode and rejects junk", () => {
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadMode, "immediate"]]).markReadMode).toBe("immediate");
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadMode, "delay"]]).markReadMode).toBe("delay");
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadMode, "never"]]).markReadMode).toBe("never");
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadMode, "nope"]]).markReadMode).toBeUndefined();
  });

  it("accepts an in-range integer markReadDelaySeconds and rejects junk", () => {
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "5"]]).markReadDelaySeconds).toBe(5);
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "0"]]).markReadDelaySeconds).toBeUndefined();
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "61"]]).markReadDelaySeconds).toBeUndefined();
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "2.5"]]).markReadDelaySeconds).toBeUndefined();
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "abc"]]).markReadDelaySeconds).toBeUndefined();
  });
```

Replace the existing defaults assertion (currently `toEqual({ defaultAccountId: "", timeFormat: "system" })`) with:

```ts
  it("exposes defaults", () => {
    expect(DEFAULT_GENERAL).toEqual({
      defaultAccountId: "",
      timeFormat: "system",
      markReadMode: "immediate",
      markReadDelaySeconds: 2,
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/general/general.test.ts`
Expected: FAIL (markReadMode/markReadDelaySeconds undefined; defaults mismatch).

- [ ] **Step 3: Implement the data layer**

Edit `src/shared/general/general.ts` to its full new content:

```ts
export type TimeFormat = "system" | "12h" | "24h";

export type MarkReadMode = "immediate" | "delay" | "never";

export type GeneralFields = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
  markReadMode: MarkReadMode;
  markReadDelaySeconds: number;
};

export const GENERAL_KEYS = {
  defaultAccountId: "general.defaultAccountId",
  timeFormat: "general.timeFormat",
  markReadMode: "general.markReadMode",
  markReadDelaySeconds: "general.markReadDelaySeconds",
} as const;

export const DEFAULT_GENERAL: GeneralFields = {
  defaultAccountId: "",
  timeFormat: "system",
  markReadMode: "immediate",
  markReadDelaySeconds: 2,
};

export const TIME_FORMATS: { value: TimeFormat; label: string }[] = [
  { value: "system", label: "System" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];

export const MARK_READ_MODES: { value: MarkReadMode; label: string }[] = [
  { value: "immediate", label: "Immediately" },
  { value: "delay", label: "After a delay" },
  { value: "never", label: "Never" },
];

function isTimeFormat(v: string): v is TimeFormat {
  return v === "system" || v === "12h" || v === "24h";
}

function isMarkReadMode(v: string): v is MarkReadMode {
  return v === "immediate" || v === "delay" || v === "never";
}

export function parseGeneralSettings(pairs: [string, string][]): Partial<GeneralFields> {
  const out: Partial<GeneralFields> = {};
  for (const [key, value] of pairs) {
    switch (key) {
      case GENERAL_KEYS.defaultAccountId:
        out.defaultAccountId = value;
        break;
      case GENERAL_KEYS.timeFormat:
        if (isTimeFormat(value)) out.timeFormat = value;
        break;
      case GENERAL_KEYS.markReadMode:
        if (isMarkReadMode(value)) out.markReadMode = value;
        break;
      case GENERAL_KEYS.markReadDelaySeconds: {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 1 && n <= 60) out.markReadDelaySeconds = n;
        break;
      }
      default:
        break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/general/general.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/general/general.ts src/shared/general/general.test.ts
git commit -m "feat(read): general settings data layer for mark-as-read mode"
```

---

### Task 2: Store slice (fields, setters, hydrate) + test-mock backfill

**Files:**
- Modify: `src/app/store.ts`
- Test: `src/app/store.test.ts`
- Modify (to keep tsc green): `src/features/message-list/MessageListPane.test.tsx`

**Interfaces:**
- Consumes: `MarkReadMode`, `DEFAULT_GENERAL` from `./shared/general/general` (Task 1).
- Produces: `UiState.markReadMode: MarkReadMode`, `UiState.markReadDelaySeconds: number`, `setMarkReadMode(v)`, `setMarkReadDelaySeconds(v)`; `hydrateGeneral` continues to apply these via its `{ ...partial }` spread.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/store.test.ts` a new describe block (after the `hydrateSnooze` block):

```ts
import { DEFAULT_GENERAL } from "../shared/general/general";

describe("general mark-as-read slice", () => {
  beforeEach(() => {
    useUiStore.setState({
      markReadMode: DEFAULT_GENERAL.markReadMode,
      markReadDelaySeconds: DEFAULT_GENERAL.markReadDelaySeconds,
      generalHydrated: false,
    });
  });

  it("setters update the mark-as-read fields", () => {
    useUiStore.getState().setMarkReadMode("delay");
    useUiStore.getState().setMarkReadDelaySeconds(7);
    const s = useUiStore.getState();
    expect(s.markReadMode).toBe("delay");
    expect(s.markReadDelaySeconds).toBe(7);
  });

  it("hydrateGeneral maps GeneralFields keys onto the store and flips generalHydrated", () => {
    useUiStore.getState().hydrateGeneral({ markReadMode: "never", markReadDelaySeconds: 10 });
    const s = useUiStore.getState();
    expect(s.markReadMode).toBe("never");
    expect(s.markReadDelaySeconds).toBe(10);
    expect(s.generalHydrated).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/store.test.ts`
Expected: FAIL (`setMarkReadMode` is not a function).

- [ ] **Step 3: Implement the store changes**

In `src/app/store.ts`:

(a) Extend the general import:

```ts
import {
  DEFAULT_GENERAL,
  type GeneralFields,
  type TimeFormat,
  type MarkReadMode,
} from "../shared/general/general";
```

(b) Add a re-export next to the existing ones:

```ts
export type { Density };
export type { TimeFormat };
export type { MarkReadMode };
```

(c) In the `UiState` type, after `timeFormat: TimeFormat;` add:

```ts
  markReadMode: MarkReadMode;
  markReadDelaySeconds: number;
```

(d) In the `UiState` type, after `setTimeFormat: (value: TimeFormat) => void;` add:

```ts
  setMarkReadMode: (value: MarkReadMode) => void;
  setMarkReadDelaySeconds: (value: number) => void;
```

(e) In the store object, after `timeFormat: DEFAULT_GENERAL.timeFormat,` add:

```ts
  markReadMode: DEFAULT_GENERAL.markReadMode,
  markReadDelaySeconds: DEFAULT_GENERAL.markReadDelaySeconds,
```

(f) In the store object, after `setTimeFormat: (timeFormat) => set({ timeFormat }),` add:

```ts
  setMarkReadMode: (markReadMode) => set({ markReadMode }),
  setMarkReadDelaySeconds: (markReadDelaySeconds) => set({ markReadDelaySeconds }),
```

Leave `hydrateGeneral: (partial) => set({ ...partial, generalHydrated: true })` unchanged — the spread already maps the new keys because the store field names equal the `GeneralFields` keys.

- [ ] **Step 4: Backfill the typed UiState test literal**

In `src/features/message-list/MessageListPane.test.tsx`, inside `setupStore`'s `const state: UiState = { ... }`, immediately after the line `hydrateGeneral: vi.fn(),`, add:

```ts
      markReadMode: "immediate",
      markReadDelaySeconds: 2,
      setMarkReadMode: vi.fn(),
      setMarkReadDelaySeconds: vi.fn(),
```

- [ ] **Step 5: Run tests + build to verify they pass**

Run: `npx vitest run src/app/store.test.ts src/features/message-list/MessageListPane.test.tsx`
Expected: PASS.
Run: `npm run build`
Expected: tsc + vite build succeed (no TS2741).

- [ ] **Step 6: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(read): store slice for mark-as-read mode and delay"
```

---

### Task 3: GeneralProvider wiring + GeneralSection "Reading" UI

**Files:**
- Modify: `src/shared/general/GeneralProvider.tsx`
- Modify: `src/features/settings/GeneralSection.tsx`
- Test: `src/shared/general/GeneralProvider.test.tsx`
- Test: `src/features/settings/GeneralSection.test.tsx`

**Interfaces:**
- Consumes: store fields/setters from Task 2; `GENERAL_KEYS`, `MARK_READ_MODES`, `MarkReadMode` from Task 1.
- Produces: `useGeneral()` now also returns `markReadMode`, `markReadDelaySeconds`, `setMarkReadMode(v)`, `setMarkReadDelaySeconds(v)` (the setters persist to `settings`).

- [ ] **Step 1: Write the failing provider test**

Add to `src/shared/general/GeneralProvider.test.tsx` (extend `Probe` and add a test). Replace the `Probe` component with:

```tsx
function Probe() {
  const g = useGeneral();
  return (
    <div>
      <span data-testid="tf">{g.timeFormat}</span>
      <span data-testid="acc">{g.defaultAccountId}</span>
      <span data-testid="mode">{g.markReadMode}</span>
      <button onClick={() => g.setTimeFormat("24h")}>set-24h</button>
      <button onClick={() => g.setDefaultAccountId("5")}>set-acc</button>
      <button onClick={() => g.setMarkReadMode("never")}>set-never</button>
      <button onClick={() => g.setMarkReadDelaySeconds(9)}>set-delay</button>
    </div>
  );
}
```

In `beforeEach`, extend the `getSettings` mock data and the store reset:

```ts
  getSettings.mockReset().mockResolvedValue({
    status: "ok",
    data: [
      ["general.timeFormat", "12h"],
      ["general.defaultAccountId", "3"],
      ["general.markReadMode", "delay"],
    ],
  });
  setSetting.mockClear();
  useUiStore.setState({
    defaultAccountId: "",
    timeFormat: "system",
    markReadMode: "immediate",
    markReadDelaySeconds: 2,
    generalHydrated: false,
  });
```

Add two tests:

```ts
  it("hydrates markReadMode from getSettings", async () => {
    render(<GeneralProvider><Probe /></GeneralProvider>);
    await waitFor(() => expect(screen.getByTestId("mode").textContent).toBe("delay"));
  });

  it("setMarkReadMode and setMarkReadDelaySeconds persist via setSetting", async () => {
    render(<GeneralProvider><Probe /></GeneralProvider>);
    await waitFor(() => expect(screen.getByTestId("mode").textContent).toBe("delay"));
    fireEvent.click(screen.getByText("set-never"));
    expect(setSetting).toHaveBeenCalledWith("general.markReadMode", "never");
    fireEvent.click(screen.getByText("set-delay"));
    expect(setSetting).toHaveBeenCalledWith("general.markReadDelaySeconds", "9");
  });
```

- [ ] **Step 2: Run the provider test to verify it fails**

Run: `npx vitest run src/shared/general/GeneralProvider.test.tsx`
Expected: FAIL (`g.markReadMode` undefined; `set-never` calls undefined).

- [ ] **Step 3: Implement the provider changes**

Edit `src/shared/general/GeneralProvider.tsx`:

(a) Extend the import:

```ts
import { GENERAL_KEYS, parseGeneralSettings, type TimeFormat, type MarkReadMode } from "./general";
```

(b) Extend `GeneralContextValue`:

```ts
type GeneralContextValue = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
  markReadMode: MarkReadMode;
  markReadDelaySeconds: number;
  setDefaultAccountId: (value: string) => void;
  setTimeFormat: (value: TimeFormat) => void;
  setMarkReadMode: (value: MarkReadMode) => void;
  setMarkReadDelaySeconds: (value: number) => void;
};
```

(c) After the existing `useUiStore` selectors, add:

```ts
  const markReadMode = useUiStore((s) => s.markReadMode);
  const markReadDelaySeconds = useUiStore((s) => s.markReadDelaySeconds);
  const storeSetMarkReadMode = useUiStore((s) => s.setMarkReadMode);
  const storeSetMarkReadDelaySeconds = useUiStore((s) => s.setMarkReadDelaySeconds);
```

(d) Replace the `useMemo` value with:

```tsx
  const value = useMemo<GeneralContextValue>(
    () => ({
      defaultAccountId,
      timeFormat,
      markReadMode,
      markReadDelaySeconds,
      setDefaultAccountId: (v) => {
        storeSetDefaultAccountId(v);
        persist(GENERAL_KEYS.defaultAccountId, v);
      },
      setTimeFormat: (v) => {
        storeSetTimeFormat(v);
        persist(GENERAL_KEYS.timeFormat, v);
      },
      setMarkReadMode: (v) => {
        storeSetMarkReadMode(v);
        persist(GENERAL_KEYS.markReadMode, v);
      },
      setMarkReadDelaySeconds: (v) => {
        storeSetMarkReadDelaySeconds(v);
        persist(GENERAL_KEYS.markReadDelaySeconds, String(v));
      },
    }),
    [
      defaultAccountId,
      timeFormat,
      markReadMode,
      markReadDelaySeconds,
      storeSetDefaultAccountId,
      storeSetTimeFormat,
      storeSetMarkReadMode,
      storeSetMarkReadDelaySeconds,
    ]
  );
```

- [ ] **Step 4: Run the provider test to verify it passes**

Run: `npx vitest run src/shared/general/GeneralProvider.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing section test**

In `src/features/settings/GeneralSection.test.tsx`, replace the `vi.hoisted` block and the `useGeneral` mock so the mode is mutable per test:

```ts
const { state, setDefaultAccountId, setTimeFormat, setMarkReadMode, setMarkReadDelaySeconds } = vi.hoisted(() => ({
  state: { markReadMode: "immediate" as "immediate" | "delay" | "never", markReadDelaySeconds: 2 },
  setDefaultAccountId: vi.fn(),
  setTimeFormat: vi.fn(),
  setMarkReadMode: vi.fn(),
  setMarkReadDelaySeconds: vi.fn(),
}));

vi.mock("../../shared/general/GeneralProvider", () => ({
  useGeneral: () => ({
    defaultAccountId: "",
    timeFormat: "system",
    markReadMode: state.markReadMode,
    markReadDelaySeconds: state.markReadDelaySeconds,
    setDefaultAccountId,
    setTimeFormat,
    setMarkReadMode,
    setMarkReadDelaySeconds,
  }),
}));
```

In `beforeEach`, reset the mutable state:

```ts
beforeEach(() => {
  vi.clearAllMocks();
  state.markReadMode = "immediate";
  state.markReadDelaySeconds = 2;
});
```

Add two tests inside `describe("GeneralSection", ...)`:

```ts
  it("selecting a mark-as-read mode persists it", () => {
    const { getByText } = render(<GeneralSection />);
    fireEvent.click(getByText("After a delay"));
    expect(setMarkReadMode).toHaveBeenCalledWith("delay");
  });

  it("shows the delay input only in delay mode and persists changes", () => {
    state.markReadMode = "delay";
    const { getByLabelText } = render(<GeneralSection />);
    const input = getByLabelText("Mark as read delay seconds") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "8" } });
    expect(setMarkReadDelaySeconds).toHaveBeenCalledWith(8);
  });

  it("hides the delay input outside delay mode", () => {
    const { queryByLabelText } = render(<GeneralSection />);
    expect(queryByLabelText("Mark as read delay seconds")).toBeNull();
  });
```

- [ ] **Step 6: Run the section test to verify it fails**

Run: `npx vitest run src/features/settings/GeneralSection.test.tsx`
Expected: FAIL ("After a delay" not found / no delay input).

- [ ] **Step 7: Implement the section UI**

Edit `src/features/settings/GeneralSection.tsx`:

(a) Extend the import:

```ts
import { TIME_FORMATS, MARK_READ_MODES } from "../../shared/general/general";
```

(b) Insert the Reading group between the Time format block and the About block (after the closing `</div>` of `theme-cards` for time format, before `<div className="appearance-field__label">About</div>`):

```tsx
      <div className="appearance-field__label">Mark messages as read</div>
      <div className="theme-cards">
        {MARK_READ_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={g.markReadMode === m.value}
            className={`theme-card${g.markReadMode === m.value ? " theme-card--active" : ""}`}
            onClick={() => g.setMarkReadMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {g.markReadMode === "delay" && (
        <>
          <div className="appearance-field__label">Delay (seconds)</div>
          <input
            type="number"
            aria-label="Mark as read delay seconds"
            min={1}
            max={60}
            value={g.markReadDelaySeconds}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 60) g.setMarkReadDelaySeconds(n);
            }}
          />
        </>
      )}
```

- [ ] **Step 8: Run the section test + build to verify they pass**

Run: `npx vitest run src/features/settings/GeneralSection.test.tsx src/shared/general/GeneralProvider.test.tsx`
Expected: PASS.
Run: `npm run build`
Expected: succeed.

- [ ] **Step 9: Commit**

```bash
git add src/shared/general/GeneralProvider.tsx src/shared/general/GeneralProvider.test.tsx src/features/settings/GeneralSection.tsx src/features/settings/GeneralSection.test.tsx
git commit -m "feat(read): General settings Reading section for mark-as-read"
```

---

### Task 4: `useSetSeen` bulk mutation hook

**Files:**
- Modify: `src/ipc/queries.ts`
- Test: `src/ipc/useSetSeen.test.tsx` (create)

**Interfaces:**
- Produces: `useSetSeen()` → a mutation whose `mutate({ ids: number[]; value: boolean })` calls `setMessageFlags(id, "seen", value)` for each id, then invalidates `messages`/`folders`/`threads`/`thread-messages`/`smart` and refreshes the unread badge.

- [ ] **Step 1: Write the failing test**

Create `src/ipc/useSetSeen.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./bindings", () => ({
  commands: {
    setMessageFlags: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    refreshUnreadBadge: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

import { commands } from "./bindings";
import { useSetSeen } from "./queries";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSetSeen", () => {
  it("calls setMessageFlags for each id with value true", async () => {
    const { result } = renderHook(() => useSetSeen(), { wrapper });
    result.current.mutate({ ids: [1, 2], value: true });
    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(1, "seen", true);
      expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "seen", true);
    });
  });

  it("passes value false for mark unread", async () => {
    const { result } = renderHook(() => useSetSeen(), { wrapper });
    result.current.mutate({ ids: [5], value: false });
    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(5, "seen", false);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ipc/useSetSeen.test.tsx`
Expected: FAIL (`useSetSeen` is not exported).

- [ ] **Step 3: Implement the hook**

In `src/ipc/queries.ts`, add this export immediately after the existing `useMarkSeen` function:

```ts
export function useSetSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, value }: { ids: number[]; value: boolean }) => {
      for (const id of ids) {
        await commands.setMessageFlags(id, "seen", value).then(unwrap);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["thread-messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ipc/useSetSeen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/queries.ts src/ipc/useSetSeen.test.tsx
git commit -m "feat(read): useSetSeen bulk read/unread mutation"
```

---

### Task 5: `seenIdsForBulk` pure helper

**Files:**
- Create: `src/features/reader/seen.ts`
- Test: `src/features/reader/seen.test.ts`

**Interfaces:**
- Produces: `seenIdsForBulk(messages: { id: number; seen: boolean }[] | undefined, value: boolean): number[]` — for `value=true` (mark read) returns only currently-unread ids; for `value=false` (mark unread) returns all ids; `[]` for empty/undefined.

- [ ] **Step 1: Write the failing test**

Create `src/features/reader/seen.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { seenIdsForBulk } from "./seen";

const msgs = [
  { id: 1, seen: true },
  { id: 2, seen: false },
  { id: 3, seen: false },
];

describe("seenIdsForBulk", () => {
  it("returns only unread ids when marking read", () => {
    expect(seenIdsForBulk(msgs, true)).toEqual([2, 3]);
  });

  it("returns all ids when marking unread", () => {
    expect(seenIdsForBulk(msgs, false)).toEqual([1, 2, 3]);
  });

  it("returns [] for empty or undefined input", () => {
    expect(seenIdsForBulk([], true)).toEqual([]);
    expect(seenIdsForBulk(undefined, false)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/reader/seen.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the helper**

Create `src/features/reader/seen.ts`:

```ts
export type SeenState = { id: number; seen: boolean };

export function seenIdsForBulk(messages: SeenState[] | undefined, value: boolean): number[] {
  if (!messages || messages.length === 0) return [];
  return value ? messages.filter((m) => !m.seen).map((m) => m.id) : messages.map((m) => m.id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/reader/seen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/seen.ts src/features/reader/seen.test.ts
git commit -m "feat(read): seenIdsForBulk helper"
```

---

### Task 6: Reader — whole-conversation auto-mark + manual toggle; simplify MessageBodyView

**Files:**
- Modify: `src/features/reader/ConversationView.tsx`
- Modify: `src/features/reader/MessageBodyView.tsx`
- Modify: `src/ipc/queries.ts` (remove the now-unused `useMarkSeen`)
- Modify: `src/test/lucide-stub.js` (add `Mail`)
- Test: `src/features/reader/ConversationView.test.tsx`
- Test: `src/features/reader/MessageBodyView.test.tsx`

**Interfaces:**
- Consumes: `useSetSeen` (Task 4), `seenIdsForBulk` (Task 5), store fields `markReadMode`/`markReadDelaySeconds`/`generalHydrated` (Task 2).
- Produces: reader auto-marks the whole open conversation per the configured mode (once per open), and a toolbar toggle button (`aria-label` "Mark as read" / "Mark as unread") drives `useSetSeen`. `MessageBodyView` no longer marks anything (its `shouldMarkSeen` prop is removed).

- [ ] **Step 1: Add the `Mail` icon to the test stub**

In `src/test/lucide-stub.js`, add a line (e.g. after the `MailOpen` line):

```js
exports.Mail = Icon;
```

- [ ] **Step 2: Write the failing/updated MessageBodyView test**

Edit `src/features/reader/MessageBodyView.test.tsx`:
- In the bindings mock, remove the `markMessageSeen` line.
- Change the iframe test render to drop the prop: `render(<MessageBodyView messageId={42} />, { wrapper: Wrapper });`
- Delete the entire `it("does not call markMessageSeen when shouldMarkSeen is false", ...)` test.

- [ ] **Step 3: Write the failing/updated ConversationView tests**

Edit `src/features/reader/ConversationView.test.tsx`:

(a) In the bindings mock object, add after the `setMessageFlags` line:

```ts
    refreshUnreadBadge: vi.fn().mockResolvedValue({ status: "ok", data: null }),
```

(b) Replace the `beforeEach` body with:

```ts
  beforeEach(() => {
    useUiStore.setState({
      composer: { open: false, draftId: null, prefill: null },
      generalHydrated: true,
      markReadMode: "immediate",
      markReadDelaySeconds: 2,
    });
  });
```

(c) Replace the two `markMessageSeen` tests (the "calls markMessageSeen for the newest message…" and "does not call markMessageSeen for non-latest message id 1" tests) with:

```ts
  it("immediate mode marks the unread message as read after the thread loads", async () => {
    const { commands } = await import("../../ipc/bindings");
    useUiStore.setState({ generalHydrated: true, markReadMode: "immediate" });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "seen", true);
    });
    expect(commands.setMessageFlags).not.toHaveBeenCalledWith(1, "seen", true);
  });

  it("never mode does not auto-mark any message", async () => {
    const { commands } = await import("../../ipc/bindings");
    useUiStore.setState({ generalHydrated: true, markReadMode: "never" });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");
    expect(commands.setMessageFlags).not.toHaveBeenCalled();
  });

  it("toolbar Mark as read button marks the unread message read", async () => {
    const { commands } = await import("../../ipc/bindings");
    useUiStore.setState({ generalHydrated: true, markReadMode: "never" });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    const btn = await screen.findByRole("button", { name: "Mark as read" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "seen", true);
    });
  });

  it("delay mode marks the unread message only after the configured delay", async () => {
    const { commands } = await import("../../ipc/bindings");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      ["thread-messages", 1],
      [
        { id: 1, account_id: 1, folder_id: 1, subject: "Hi", from_address: "a@x", from_name: "A", date: 1, seen: true, flagged: false, has_attachments: false, snippet: "" },
        { id: 2, account_id: 1, folder_id: 1, subject: "Re: Hi", from_address: "b@y", from_name: "B", date: 2, seen: false, flagged: true, has_attachments: false, snippet: "" },
      ]
    );
    useUiStore.setState({ generalHydrated: true, markReadMode: "delay", markReadDelaySeconds: 2 });
    vi.useFakeTimers();
    render(
      <QueryClientProvider client={qc}>
        <ConversationView threadId={1} />
      </QueryClientProvider>
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.setMessageFlags).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "seen", true);
    vi.useRealTimers();
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/features/reader/ConversationView.test.tsx src/features/reader/MessageBodyView.test.tsx`
Expected: FAIL (no "Mark as read" button; setMessageFlags not called by auto-mark; MessageBodyView still has the prop).

- [ ] **Step 5: Simplify MessageBodyView**

Replace `src/features/reader/MessageBodyView.tsx` with:

```tsx
import { useState, useEffect } from "react";
import { useRenderedMessage, useMessageBody } from "../../ipc/queries";
import { SafeHtmlFrame } from "./SafeHtmlFrame";

function RemoteContentBanner({ onLoad }: { onLoad: () => void }) {
  return (
    <div className="remote-content-banner" role="alert">
      <span>Remote content blocked</span>
      <button type="button" onClick={onLoad}>
        Load images
      </button>
    </div>
  );
}

export function MessageBodyView({ messageId }: { messageId: number }) {
  const [forceLoadRemote, setForceLoadRemote] = useState(false);
  const { data: rendered, isLoading: renderLoading } = useRenderedMessage(messageId, forceLoadRemote);
  const { data: body, isLoading: bodyLoading } = useMessageBody(messageId);

  useEffect(() => {
    setForceLoadRemote(false);
  }, [messageId]);

  if (renderLoading && rendered == null) {
    return <p className="loading-state">Loading…</p>;
  }

  if (rendered?.html != null) {
    return (
      <div className="message-body">
        {rendered.blocked_remote_content && <RemoteContentBanner onLoad={() => setForceLoadRemote(true)} />}
        <SafeHtmlFrame html={rendered.html} />
      </div>
    );
  }

  if (bodyLoading) {
    return <p className="loading-state">Loading…</p>;
  }

  if (body?.text_plain != null) {
    return (
      <div className="message-body">
        <pre className="plain-text-body">{body.text_plain}</pre>
      </div>
    );
  }

  return <p className="empty-state">No content available</p>;
}
```

- [ ] **Step 6: Implement the ConversationView changes**

Edit `src/features/reader/ConversationView.tsx`:

(a) Update the React import to add `useRef`:

```ts
import { useEffect, useRef, useState } from "react";
```

(b) Update the lucide import to add `Mail, MailOpen`:

```ts
import { Reply, ReplyAll, Forward, Star, Archive, Clock, Trash2, MoreHorizontal, SendHorizontal, Tag, Mail, MailOpen } from "lucide-react";
```

(c) Update the queries import to add `useSetSeen` and drop nothing else:

```ts
import { useThreadMessages, useStartReply, useSetFlag, useLabelsForMessages, useSetSeen } from "../../ipc/queries";
```

(d) Add the seen helper import below the other feature imports:

```ts
import { seenIdsForBulk } from "./seen";
```

(e) Inside the component, after `const timeFormat = useUiStore((s) => s.timeFormat);`, add:

```ts
  const markReadMode = useUiStore((s) => s.markReadMode);
  const markReadDelaySeconds = useUiStore((s) => s.markReadDelaySeconds);
  const generalHydrated = useUiStore((s) => s.generalHydrated);
  const setSeen = useSetSeen();
```

(f) After the existing `useEffect` that resets `activeId`, add the auto-mark effects:

```ts
  const autoMarkDoneRef = useRef(false);
  const markTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    autoMarkDoneRef.current = false;
    if (markTimerRef.current) {
      clearTimeout(markTimerRef.current);
      markTimerRef.current = null;
    }
  }, [threadId]);

  useEffect(() => {
    return () => {
      if (markTimerRef.current) clearTimeout(markTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (autoMarkDoneRef.current) return;
    if (!generalHydrated) return;
    if (isLoading || messages == null) return;
    autoMarkDoneRef.current = true;
    if (markReadMode === "never") return;
    const ids = seenIdsForBulk(messages, true);
    if (ids.length === 0) return;
    if (markReadMode === "immediate") {
      setSeen.mutate({ ids, value: true });
    } else {
      markTimerRef.current = setTimeout(() => {
        setSeen.mutate({ ids, value: true });
      }, markReadDelaySeconds * 1000);
    }
  }, [threadId, generalHydrated, isLoading, messages, markReadMode, markReadDelaySeconds, setSeen]);
```

(g) After `const senderName = last.from_name || last.from_address;`, add:

```ts
  const anyUnread = messages.some((m) => !m.seen);
```

(h) In the toolbar, insert the toggle button immediately after the Snooze `<button>…</button>` block (the one with `aria-label="Snooze"`):

```tsx
        <button
          type="button"
          className="reader__icon"
          aria-label={anyUnread ? "Mark as read" : "Mark as unread"}
          onClick={() => setSeen.mutate({ ids: seenIdsForBulk(messages, anyUnread), value: anyUnread })}
        >
          {anyUnread ? <MailOpen size={18} /> : <Mail size={18} />}
        </button>
```

(i) Change the `MessageBodyView` usage to drop the prop:

```tsx
                  <MessageBodyView messageId={m.id} />
```

- [ ] **Step 7: Remove the now-unused `useMarkSeen` hook**

In `src/ipc/queries.ts`, delete the entire `export function useMarkSeen() { ... }` block (its only consumer, `MessageBodyView`, no longer imports it).

- [ ] **Step 8: Run the reader tests + build to verify they pass**

Run: `npx vitest run src/features/reader/ConversationView.test.tsx src/features/reader/MessageBodyView.test.tsx`
Expected: PASS.
Run: `npm run build`
Expected: succeed (no unused-import errors; `useMarkSeen` no longer referenced anywhere in `src/`).

- [ ] **Step 9: Commit**

```bash
git add src/features/reader/ConversationView.tsx src/features/reader/MessageBodyView.tsx src/features/reader/ConversationView.test.tsx src/features/reader/MessageBodyView.test.tsx src/ipc/queries.ts src/test/lucide-stub.js
git commit -m "feat(read): whole-conversation auto-mark + reader read/unread toggle"
```

---

### Task 7: Shortcuts — Shift+I / Shift+U act on the whole conversation

**Files:**
- Modify: `src/features/shortcuts/ShortcutsProvider.tsx`
- Test: `src/features/shortcuts/ShortcutsProvider.markSeen.test.tsx` (create)

**Interfaces:**
- Consumes: `useSetSeen` (Task 4), `seenIdsForBulk` (Task 5).
- Produces: the `setSeen(value)` handler marks every unread message in the open conversation read (`value=true`) or every message unread (`value=false`), reading the `["thread-messages", selectedThreadId]` query cache.

- [ ] **Step 1: Write the failing test**

Create `src/features/shortcuts/ShortcutsProvider.markSeen.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { setSeenMutate } = vi.hoisted(() => ({ setSeenMutate: vi.fn() }));

vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./CheatSheet", () => ({ CheatSheet: () => null }));
vi.mock("../labels/LabelPicker", () => ({ LabelPicker: () => null }));
vi.mock("../snooze/SnoozePicker", () => ({ SnoozePicker: () => null }));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

vi.mock("../../ipc/queries", () => ({
  useStartReply: () => ({ mutateAsync: vi.fn() }),
  useSetFlag: () => ({ mutate: vi.fn() }),
  useSetSeen: () => ({ mutate: setSeenMutate }),
}));

import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ selectedThreadId: null });
});

function renderProvider(threadId: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["thread-messages", threadId], [
    { id: 1, seen: true },
    { id: 2, seen: false },
  ]);
  return render(
    <QueryClientProvider client={qc}>
      <ShortcutsProvider>
        <div />
      </ShortcutsProvider>
    </QueryClientProvider>
  );
}

describe("ShortcutsProvider mark read/unread", () => {
  it("Shift+I marks unread messages in the open conversation read", async () => {
    useUiStore.setState({ selectedThreadId: 5, composer: { open: false, draftId: null, prefill: null } });
    renderProvider(5);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "I", shiftKey: true }));
    await waitFor(() => expect(setSeenMutate).toHaveBeenCalledWith({ ids: [2], value: true }));
  });

  it("Shift+U marks all messages in the open conversation unread", async () => {
    useUiStore.setState({ selectedThreadId: 5, composer: { open: false, draftId: null, prefill: null } });
    renderProvider(5);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "U", shiftKey: true }));
    await waitFor(() => expect(setSeenMutate).toHaveBeenCalledWith({ ids: [1, 2], value: false }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/shortcuts/ShortcutsProvider.markSeen.test.tsx`
Expected: FAIL (current `setSeen` calls `setFlag` on a single `replyTargetId`, not `setSeenMutate`).

- [ ] **Step 3: Implement the shortcuts change**

Edit `src/features/shortcuts/ShortcutsProvider.tsx`:

(a) Extend the queries import and add the helper import:

```ts
import { useStartReply, useSetFlag, useSetSeen } from "../../ipc/queries";
import { seenIdsForBulk } from "../reader/seen";
```

(b) After `const setFlag = useSetFlag();`, add:

```ts
  const setSeenBulk = useSetSeen();
```

(c) Replace the existing `setSeen` `useCallback` with:

```ts
  const setSeen = useCallback(
    (value: boolean) => {
      const s = useUiStore.getState();
      if (s.selectedThreadId == null) return;
      const messages = queryClient.getQueryData<{ id: number; seen: boolean }[]>([
        "thread-messages",
        s.selectedThreadId,
      ]);
      const ids = seenIdsForBulk(messages, value);
      if (ids.length === 0) return;
      setSeenBulk.mutate({ ids, value });
    },
    [setSeenBulk, queryClient]
  );
```

- [ ] **Step 4: Run the test + build to verify they pass**

Run: `npx vitest run src/features/shortcuts/ShortcutsProvider.markSeen.test.tsx`
Expected: PASS. (If `setSeenMutate` is not called, confirm the engine maps `Shift+I` to step `"I"`; the `mark-read` default binding is `"I"`.)
Run: `npm run build`
Expected: succeed.

- [ ] **Step 5: Commit**

```bash
git add src/features/shortcuts/ShortcutsProvider.tsx src/features/shortcuts/ShortcutsProvider.markSeen.test.tsx
git commit -m "feat(read): Shift+I/U mark the whole conversation read/unread"
```

---

### Task 8: List multi-select — Mark read / Mark unread buttons

**Files:**
- Modify: `src/features/message-list/MessageListPane.tsx`
- Test: `src/features/message-list/MessageListPane.test.tsx`
- Modify: `src/app/AppShell.test.tsx` (add `useSetSeen` to its queries mock, since AppShell renders MessageListPane)

**Interfaces:**
- Consumes: `useSetSeen` (Task 4), existing store `selectedMessageIds`/`clearSelection`.
- Produces: in the flat-mode selection toolbar, "Mark read" / "Mark unread" buttons call `useSetSeen().mutate({ ids: selectedMessageIds, value })` and then `clearSelection()`.

- [ ] **Step 1: Write the failing test**

In `src/features/message-list/MessageListPane.test.tsx`:

(a) Add a captured mock near the other module-level mocks (after `const mockUnsnooze = { mutate: vi.fn() };`):

```ts
const mockSetSeen = { mutate: vi.fn() };
```

(b) In the `vi.mock("../../ipc/queries", ...)` factory object, add:

```ts
  useSetSeen: () => mockSetSeen,
```

(c) Add a test inside `describe("MessageListPane", ...)` (mirrors the existing snooze-selection tests; `setupStore(null, "comfortable", "unread", false, "", null, true, [100])` puts the pane in flat smart-folder mode with selection active and message 100 selected):

```ts
  it("selection toolbar Mark read calls setSeen with value true and clears selection", () => {
    setupStore(null, "comfortable", "unread", false, "", null, true, [100]);
    mockUseSmartFolder.mockReturnValue({
      data: [
        { message_id: 100, account_id: 1, folder_id: 1, account_color: "#4f46e5", from_address: "a@b.com", from_name: "A", subject: "S", date: 1000, seen: false, flagged: false, has_attachments: false, snippet: "" },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useSmartFolder>);

    renderPane();
    fireEvent.click(screen.getByText("Mark read"));

    expect(mockSetSeen.mutate).toHaveBeenCalledWith({ ids: [100], value: true });
    expect(mockClearSelection).toHaveBeenCalled();
  });

  it("selection toolbar Mark unread calls setSeen with value false", () => {
    setupStore(null, "comfortable", "unread", false, "", null, true, [100]);
    mockUseSmartFolder.mockReturnValue({
      data: [
        { message_id: 100, account_id: 1, folder_id: 1, account_color: "#4f46e5", from_address: "a@b.com", from_name: "A", subject: "S", date: 1000, seen: true, flagged: false, has_attachments: false, snippet: "" },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useSmartFolder>);

    renderPane();
    fireEvent.click(screen.getByText("Mark unread"));

    expect(mockSetSeen.mutate).toHaveBeenCalledWith({ ids: [100], value: false });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/message-list/MessageListPane.test.tsx`
Expected: FAIL ("Mark read" button not found).

- [ ] **Step 3: Implement the toolbar buttons**

Edit `src/features/message-list/MessageListPane.tsx`:

(a) Add `useSetSeen` to the queries import:

```ts
import { useThreads, useSmartFolder, useSearch, useLabelsForMessages, useMessagesByLabel, useLabels, useUnsnooze, useSetSeen } from "../../ipc/queries";
```

(b) After `const unsnooze = useUnsnooze();`, add:

```ts
  const setSeen = useSetSeen();
```

(c) In the selection toolbar (`<div className="message-list__selection-bar" …>`), insert the two buttons immediately after the `Label` button and before the snooze/unsnooze conditional:

```tsx
          <button
            type="button"
            disabled={selectedMessageIds.length === 0}
            onClick={() => {
              setSeen.mutate({ ids: selectedMessageIds, value: true });
              clearSelection();
            }}
          >
            Mark read
          </button>
          <button
            type="button"
            disabled={selectedMessageIds.length === 0}
            onClick={() => {
              setSeen.mutate({ ids: selectedMessageIds, value: false });
              clearSelection();
            }}
          >
            Mark unread
          </button>
```

- [ ] **Step 4: Add `useSetSeen` to the AppShell queries mock**

In `src/app/AppShell.test.tsx`, inside the `vi.mock("../ipc/queries", ...)` factory, add a line (e.g. after `useUnsnooze: () => ({ mutate: vi.fn() }),`):

```ts
  useSetSeen: () => ({ mutate: vi.fn() }),
```

- [ ] **Step 5: Run the tests + build to verify they pass**

Run: `npx vitest run src/features/message-list/MessageListPane.test.tsx src/app/AppShell.test.tsx`
Expected: PASS.
Run: `npm run build`
Expected: succeed.

- [ ] **Step 6: Commit**

```bash
git add src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.test.tsx src/app/AppShell.test.tsx
git commit -m "feat(read): list multi-select mark read/unread buttons"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `npx vitest run`
Expected: all tests PASS (no OOM; the `Mail` icon stub and the extended UiState/queries mocks are in place).

- [ ] **Step 2: Run the production build**

Run: `npm run build`
Expected: tsc + vite build succeed with no errors.

- [ ] **Step 3: Manual smoke (optional, if running the app)**

Open Settings → General → "Mark messages as read": switch between Immediately / After a delay (set seconds) / Never; open a conversation and confirm the unread dots clear per the chosen mode; use the reader envelope button and the list multi-select "Mark read"/"Mark unread"; confirm `Shift+I`/`Shift+U` in an open conversation.

- [ ] **Step 4: Commit (only if Step 3 produced fixes)**

```bash
git add -A
git commit -m "test(read): verify mark-as-read across the suite"
```

---

## Self-Review

**Spec coverage:**
- Configurable timing mode (immediate/delay/never) → Tasks 1–3.
- Default `immediate` → Task 1 (`DEFAULT_GENERAL`).
- Auto-mark whole conversation, once per open, delay timer cleared on switch → Task 6.
- Manual reader toggle → Task 6; list multi-select buttons → Task 8; shortcuts aligned → Task 7.
- Shared `useSetSeen` + `seenIdsForBulk` → Tasks 4–5 (reused in 6/7/8).
- Settings UI in General (no new nav) → Task 3.
- Frontend-only / no Rust / no migration / no bindings regen → honored throughout (only `set_message_flags`, `refreshUnreadBadge`, `getSettings`, `setSetting` are used; all pre-existing).
- Mock backfill (UiState literal, AppShell queries mock, lucide `Mail`) → Tasks 2, 6, 8.

**Placeholder scan:** none — every code/test step contains complete content.

**Type consistency:** `MarkReadMode`, `GENERAL_KEYS.markReadMode`/`markReadDelaySeconds`, `seenIdsForBulk(messages, value)`, and `useSetSeen({ ids, value })` are used identically across Tasks 1–8.

**Note:** the working tree carries unrelated uncommitted changes (`AccountsSection`, `V11__attachments_content.sql`, `AttachmentsBar`, …). Each task above stages only its own files, so those remain untouched.
