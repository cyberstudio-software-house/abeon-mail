# Etap 7c — General + Snooze settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two functional Settings sections — **General** (default account opened on startup + date/time format) and **Snooze** (configurable preset times) — replacing the current "Coming soon" placeholders.

**Architecture:** Frontend-only, zero Rust, zero migration. Each settings domain follows the established pattern: a constants module (`KEYS`/`DEFAULTS`/`parse`) → a Provider (hydrate from `getSettings`, persist via `setSetting`) → a `useUiStore` slice (live fields + setters + `hydrate*`) → a Section component → mount in `main.tsx` → wire a branch in `SettingsOverlay`. A startup hook opens the default account's Inbox; configurable values flow into the existing snooze preset math and the date formatters.

**Tech Stack:** React 19 + TypeScript, zustand (`useUiStore`), @tanstack/react-query v5, vitest + @testing-library/react + happy-dom. Settings persist through existing `get_settings`/`set_setting` Tauri commands over the generic V6 `settings` key/value table.

## Global Constraints

- All code identifiers in English. No other language at code level. (CLAUDE.md)
- No code comments in source files. Document in `docs/` if truly needed. (CLAUDE.md)
- Conventional Commits 1.0.0. Do NOT add a co-author. Do NOT push (only when asked). (CLAUDE.md)
- Never `git add .` — stage explicit paths only. A gitignored `client_secret_*.json`/`.env` must never be committed.
- Zero Rust changes, zero DB migration, zero bindings regen — this etap is entirely under `src/`.
- Settings values are strings: booleans → `"true"`/`"false"`, numbers → decimal string.
- Settings key namespace is dotted `feature.setting`: `general.defaultAccountId`, `general.timeFormat`, `snooze.morningHour`, `snooze.laterTodayHours`, `snooze.weekendDay`, `snooze.weekStartDay`.
- `TimeFormat` default `"system"` MUST produce byte-identical output to today (omit `hour12`). 12h/24h affect only the hour portion, never month/day.
- Snooze defaults equal today's hardcoded values: `morningHour=8`, `laterTodayHours=3`, `weekendDay=6` (Saturday), `weekStartDay=1` (Monday).
- Default account stored as `general.defaultAccountId`; empty string = "Automatic (first account by `position`)". A stored id that matches no current account falls back to the first account by `position`.
- Test-infra: vitest does NOT typecheck; `npm run build` is `tsc && vite build` with `tsconfig` `include: ["src"]`, so **test files ARE typechecked**. `tsconfig` has `noUnusedLocals`/`noUnusedParameters` ON → run BOTH `npx vitest run` AND `npm run build` after every task. New lucide icons used in app code MUST be added to `src/test/lucide-stub.js` (none expected in 7c). Tests use `.toBeTruthy()`/`.toBeNull()` (no jest-dom).
- **Latent build-breaker:** `src/features/message-list/MessageListPane.test.tsx` builds a complete `const state: UiState = { ... }` literal inside its `setupStore` helper. Every task that adds a field or setter to `UiState` (Tasks 1 and 2) MUST extend that literal in the same task, or `tsc` fails with TS2741. This is handled explicitly in those tasks.
- Node 24 PATH for every command: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`.

---

### Task 1: General settings module + store slice

**Files:**
- Create: `src/shared/general/general.ts`
- Create: `src/shared/general/general.test.ts`
- Modify: `src/app/store.ts`
- Modify: `src/features/message-list/MessageListPane.test.tsx` (extend the `UiState` literal)

**Interfaces:**
- Produces: `type TimeFormat = "system" | "12h" | "24h"`; `type GeneralFields = { defaultAccountId: string; timeFormat: TimeFormat }`; `GENERAL_KEYS = { defaultAccountId: "general.defaultAccountId", timeFormat: "general.timeFormat" }`; `DEFAULT_GENERAL: GeneralFields`; `TIME_FORMATS: { value: TimeFormat; label: string }[]`; `parseGeneralSettings(pairs: [string,string][]): Partial<GeneralFields>`.
- Produces (store): fields `defaultAccountId: string`, `timeFormat: TimeFormat`, `generalHydrated: boolean`; setters `setDefaultAccountId(v: string)`, `setTimeFormat(v: TimeFormat)`; `hydrateGeneral(partial: Partial<GeneralFields>)` (also flips `generalHydrated` true). `TimeFormat` re-exported from store.

- [ ] **Step 1: Write the failing test**

Create `src/shared/general/general.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseGeneralSettings, DEFAULT_GENERAL, GENERAL_KEYS } from "./general";

describe("parseGeneralSettings", () => {
  it("reads defaultAccountId as a raw string", () => {
    const out = parseGeneralSettings([[GENERAL_KEYS.defaultAccountId, "7"]]);
    expect(out.defaultAccountId).toBe("7");
  });

  it("accepts an empty defaultAccountId (automatic)", () => {
    const out = parseGeneralSettings([[GENERAL_KEYS.defaultAccountId, ""]]);
    expect(out.defaultAccountId).toBe("");
  });

  it("whitelists timeFormat and rejects junk", () => {
    expect(parseGeneralSettings([[GENERAL_KEYS.timeFormat, "12h"]]).timeFormat).toBe("12h");
    expect(parseGeneralSettings([[GENERAL_KEYS.timeFormat, "24h"]]).timeFormat).toBe("24h");
    expect(parseGeneralSettings([[GENERAL_KEYS.timeFormat, "system"]]).timeFormat).toBe("system");
    expect(parseGeneralSettings([[GENERAL_KEYS.timeFormat, "nonsense"]]).timeFormat).toBeUndefined();
  });

  it("ignores unrelated keys", () => {
    expect(parseGeneralSettings([["appearance.theme", "dark"]])).toEqual({});
  });

  it("exposes defaults", () => {
    expect(DEFAULT_GENERAL).toEqual({ defaultAccountId: "", timeFormat: "system" });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/general/general.test.ts`
Expected: FAIL — cannot resolve `./general`.

- [ ] **Step 3: Create the module**

Create `src/shared/general/general.ts`:

```ts
export type TimeFormat = "system" | "12h" | "24h";

export type GeneralFields = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
};

export const GENERAL_KEYS = {
  defaultAccountId: "general.defaultAccountId",
  timeFormat: "general.timeFormat",
} as const;

export const DEFAULT_GENERAL: GeneralFields = {
  defaultAccountId: "",
  timeFormat: "system",
};

export const TIME_FORMATS: { value: TimeFormat; label: string }[] = [
  { value: "system", label: "System" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];

function isTimeFormat(v: string): v is TimeFormat {
  return v === "system" || v === "12h" || v === "24h";
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
      default:
        break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/general/general.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the General slice to the store**

In `src/app/store.ts`:

Add to the imports block (after the appearance import, near line 9):

```ts
import {
  DEFAULT_GENERAL,
  type GeneralFields,
  type TimeFormat,
} from "../shared/general/general";
```

After `export type { Density };` (line 12) add:

```ts
export type { TimeFormat };
```

In the `UiState` type, after `badgeEnabled: boolean;` (line 33) add:

```ts
  defaultAccountId: string;
  timeFormat: TimeFormat;
  generalHydrated: boolean;
```

In the `UiState` type, after `hydrateNotifications: (...) => void;` (line 66) add:

```ts
  setDefaultAccountId: (value: string) => void;
  setTimeFormat: (value: TimeFormat) => void;
  hydrateGeneral: (partial: Partial<GeneralFields>) => void;
```

In the store initializer object, after `badgeEnabled: DEFAULT_NOTIFICATIONS.badgeEnabled,` (line 109) add:

```ts
  defaultAccountId: DEFAULT_GENERAL.defaultAccountId,
  timeFormat: DEFAULT_GENERAL.timeFormat,
  generalHydrated: false,
```

In the store implementation, after `hydrateNotifications: (partial) => set(partial),` (line 153) add:

```ts
  setDefaultAccountId: (defaultAccountId) => set({ defaultAccountId }),
  setTimeFormat: (timeFormat) => set({ timeFormat }),
  hydrateGeneral: (partial) => set({ ...partial, generalHydrated: true }),
```

- [ ] **Step 6: Extend the complete UiState literal in MessageListPane.test**

`src/features/message-list/MessageListPane.test.tsx` has, inside `setupStore`, a `const state: UiState = { ... }` literal that must satisfy the whole (now-wider) `UiState`. Add these members anywhere inside that literal (the file already imports `vi`):

```ts
      defaultAccountId: "",
      timeFormat: "system",
      generalHydrated: true,
      setDefaultAccountId: vi.fn(),
      setTimeFormat: vi.fn(),
      hydrateGeneral: vi.fn(),
```

Without this, `npm run build` fails with TS2741 (the vitest run alone stays green, which is the trap).

- [ ] **Step 7: Verify suite + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run && npm run build`
Expected: all tests PASS; build clean (no TS6133/TS2741).

- [ ] **Step 8: Commit**

```bash
git add src/shared/general/general.ts src/shared/general/general.test.ts src/app/store.ts src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(settings): general settings module and store slice"
```

---

### Task 2: Snooze settings module + parameterized presets + store slice

**Files:**
- Modify: `src/shared/snooze/snooze.ts`
- Modify: `src/shared/snooze/snooze.test.ts`
- Modify: `src/app/store.ts`
- Modify: `src/features/snooze/SnoozePicker.tsx`
- Modify: `src/features/message-list/MessageListPane.test.tsx` (extend the `UiState` literal)

**Interfaces:**
- Consumes: `presetTimestamp` callers, `SnoozePicker`.
- Produces: `type SnoozeConfig = { morningHour: number; laterTodayHours: number; weekendDay: number; weekStartDay: number }`; `SNOOZE_KEYS`; `DEFAULT_SNOOZE_CONFIG: SnoozeConfig`; `parseSnoozeSettings(pairs): Partial<SnoozeConfig>`; **new** `presetTimestamp(kind, now, config: SnoozeConfig): number`.
- Produces (store): fields `snoozeMorningHour`, `snoozeLaterTodayHours`, `snoozeWeekendDay`, `snoozeWeekStartDay` (numbers); setters `setSnoozeMorningHour`, `setSnoozeLaterTodayHours`, `setSnoozeWeekendDay`, `setSnoozeWeekStartDay`; `hydrateSnooze(partial: Partial<SnoozeConfig>)`.

- [ ] **Step 1: Write the failing test (update snooze.test.ts)**

Replace the body of `src/shared/snooze/snooze.test.ts` with (note `formatWakeTime` is intentionally dropped here — it moves to `datetime.ts` in Task 3; keep it imported and tested until then):

```ts
import { describe, it, expect } from "vitest";
import {
  nextWeekdayAt,
  tomorrowAt,
  presetTimestamp,
  formatWakeTime,
  parseSnoozeSettings,
  DEFAULT_SNOOZE_CONFIG,
  SNOOZE_KEYS,
} from "./snooze";

const FRIDAY = new Date(2026, 5, 19, 10, 0, 0);

describe("snooze presets", () => {
  it("later_today is now + laterTodayHours", () => {
    const ts = presetTimestamp("later_today", FRIDAY, DEFAULT_SNOOZE_CONFIG);
    expect(ts).toBe(Math.floor(FRIDAY.getTime() / 1000) + 3 * 3600);
  });

  it("respects a custom laterTodayHours offset", () => {
    const ts = presetTimestamp("later_today", FRIDAY, { ...DEFAULT_SNOOZE_CONFIG, laterTodayHours: 5 });
    expect(ts).toBe(Math.floor(FRIDAY.getTime() / 1000) + 5 * 3600);
  });

  it("tomorrow uses the configured morningHour", () => {
    const ts = presetTimestamp("tomorrow", FRIDAY, { ...DEFAULT_SNOOZE_CONFIG, morningHour: 6 });
    const d = new Date(ts * 1000);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(6);
  });

  it("this_weekend uses the configured weekendDay + morningHour", () => {
    const ts = presetTimestamp("this_weekend", FRIDAY, { ...DEFAULT_SNOOZE_CONFIG, weekendDay: 0, morningHour: 9 });
    const d = new Date(ts * 1000);
    expect(d.getDay()).toBe(0);
    expect(d.getHours()).toBe(9);
  });

  it("next_week uses the configured weekStartDay", () => {
    const ts = presetTimestamp("next_week", FRIDAY, { ...DEFAULT_SNOOZE_CONFIG, weekStartDay: 2 });
    const d = new Date(ts * 1000);
    expect(d.getDay()).toBe(2);
  });

  it("default config matches the legacy hardcoded behaviour", () => {
    expect(presetTimestamp("tomorrow", FRIDAY, DEFAULT_SNOOZE_CONFIG)).toBe(tomorrowAt(FRIDAY, 8));
    expect(presetTimestamp("this_weekend", FRIDAY, DEFAULT_SNOOZE_CONFIG)).toBe(nextWeekdayAt(FRIDAY, 6, 8));
    expect(presetTimestamp("next_week", FRIDAY, DEFAULT_SNOOZE_CONFIG)).toBe(nextWeekdayAt(FRIDAY, 1, 8));
  });

  it("formatWakeTime returns a non-empty string", () => {
    expect(formatWakeTime(Math.floor(FRIDAY.getTime() / 1000)).length).toBeGreaterThan(0);
  });
});

describe("parseSnoozeSettings", () => {
  it("parses valid integers in range", () => {
    const out = parseSnoozeSettings([
      [SNOOZE_KEYS.morningHour, "7"],
      [SNOOZE_KEYS.laterTodayHours, "4"],
      [SNOOZE_KEYS.weekendDay, "0"],
      [SNOOZE_KEYS.weekStartDay, "3"],
    ]);
    expect(out).toEqual({ morningHour: 7, laterTodayHours: 4, weekendDay: 0, weekStartDay: 3 });
  });

  it("rejects out-of-range and non-integer values", () => {
    expect(parseSnoozeSettings([[SNOOZE_KEYS.morningHour, "24"]]).morningHour).toBeUndefined();
    expect(parseSnoozeSettings([[SNOOZE_KEYS.laterTodayHours, "0"]]).laterTodayHours).toBeUndefined();
    expect(parseSnoozeSettings([[SNOOZE_KEYS.weekendDay, "9"]]).weekendDay).toBeUndefined();
    expect(parseSnoozeSettings([[SNOOZE_KEYS.morningHour, "abc"]]).morningHour).toBeUndefined();
    expect(parseSnoozeSettings([[SNOOZE_KEYS.morningHour, "1.5"]]).morningHour).toBeUndefined();
  });

  it("exposes defaults equal to the legacy values", () => {
    expect(DEFAULT_SNOOZE_CONFIG).toEqual({ morningHour: 8, laterTodayHours: 3, weekendDay: 6, weekStartDay: 1 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/snooze/snooze.test.ts`
Expected: FAIL — `parseSnoozeSettings`/`DEFAULT_SNOOZE_CONFIG`/`SNOOZE_KEYS` not exported; `presetTimestamp` arity mismatch.

- [ ] **Step 3: Extend snooze.ts**

In `src/shared/snooze/snooze.ts`, add after the `SNOOZE_PRESETS` declaration (after line 8):

```ts
export type SnoozeConfig = {
  morningHour: number;
  laterTodayHours: number;
  weekendDay: number;
  weekStartDay: number;
};

export const SNOOZE_KEYS = {
  morningHour: "snooze.morningHour",
  laterTodayHours: "snooze.laterTodayHours",
  weekendDay: "snooze.weekendDay",
  weekStartDay: "snooze.weekStartDay",
} as const;

export const DEFAULT_SNOOZE_CONFIG: SnoozeConfig = {
  morningHour: 8,
  laterTodayHours: 3,
  weekendDay: 6,
  weekStartDay: 1,
};

function parseIntInRange(value: string, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function parseSnoozeSettings(pairs: [string, string][]): Partial<SnoozeConfig> {
  const out: Partial<SnoozeConfig> = {};
  for (const [key, value] of pairs) {
    switch (key) {
      case SNOOZE_KEYS.morningHour: {
        const n = parseIntInRange(value, 0, 23);
        if (n !== null) out.morningHour = n;
        break;
      }
      case SNOOZE_KEYS.laterTodayHours: {
        const n = parseIntInRange(value, 1, 12);
        if (n !== null) out.laterTodayHours = n;
        break;
      }
      case SNOOZE_KEYS.weekendDay: {
        const n = parseIntInRange(value, 0, 6);
        if (n !== null) out.weekendDay = n;
        break;
      }
      case SNOOZE_KEYS.weekStartDay: {
        const n = parseIntInRange(value, 0, 6);
        if (n !== null) out.weekStartDay = n;
        break;
      }
      default:
        break;
    }
  }
  return out;
}
```

Replace the existing `presetTimestamp` function (lines 27–38) with:

```ts
export function presetTimestamp(kind: SnoozePresetKind, now: Date, config: SnoozeConfig): number {
  switch (kind) {
    case "later_today":
      return toEpochSeconds(now) + config.laterTodayHours * 3600;
    case "tomorrow":
      return tomorrowAt(now, config.morningHour);
    case "this_weekend":
      return nextWeekdayAt(now, config.weekendDay, config.morningHour);
    case "next_week":
      return nextWeekdayAt(now, config.weekStartDay, config.morningHour);
  }
}
```

Leave `formatWakeTime` unchanged in this task.

- [ ] **Step 4: Update SnoozePicker to pass config from the store**

In `src/features/snooze/SnoozePicker.tsx`, the import on line 5 stays as-is. Add these store reads after the existing `const closeSnoozePicker = ...` line (line 11):

```ts
  const morningHour = useUiStore((s) => s.snoozeMorningHour);
  const laterTodayHours = useUiStore((s) => s.snoozeLaterTodayHours);
  const weekendDay = useUiStore((s) => s.snoozeWeekendDay);
  const weekStartDay = useUiStore((s) => s.snoozeWeekStartDay);
```

Replace `applyPreset` (lines 26–28):

```ts
  function applyPreset(kind: SnoozePresetKind) {
    apply(presetTimestamp(kind, new Date(), { morningHour, laterTodayHours, weekendDay, weekStartDay }));
  }
```

- [ ] **Step 5: Add the Snooze slice to the store**

In `src/app/store.ts`:

Add to the imports block (near the general import from Task 1):

```ts
import {
  DEFAULT_SNOOZE_CONFIG,
  type SnoozeConfig,
} from "../shared/snooze/snooze";
```

In the `UiState` type, after the `generalHydrated: boolean;` fields (added in Task 1) add:

```ts
  snoozeMorningHour: number;
  snoozeLaterTodayHours: number;
  snoozeWeekendDay: number;
  snoozeWeekStartDay: number;
```

In the `UiState` type, after `hydrateGeneral: (...) => void;` add:

```ts
  setSnoozeMorningHour: (value: number) => void;
  setSnoozeLaterTodayHours: (value: number) => void;
  setSnoozeWeekendDay: (value: number) => void;
  setSnoozeWeekStartDay: (value: number) => void;
  hydrateSnooze: (partial: Partial<SnoozeConfig>) => void;
```

In the store initializer, after the `generalHydrated: false,` line add:

```ts
  snoozeMorningHour: DEFAULT_SNOOZE_CONFIG.morningHour,
  snoozeLaterTodayHours: DEFAULT_SNOOZE_CONFIG.laterTodayHours,
  snoozeWeekendDay: DEFAULT_SNOOZE_CONFIG.weekendDay,
  snoozeWeekStartDay: DEFAULT_SNOOZE_CONFIG.weekStartDay,
```

In the store implementation, after `hydrateGeneral: (...) => set(...),` add:

```ts
  setSnoozeMorningHour: (snoozeMorningHour) => set({ snoozeMorningHour }),
  setSnoozeLaterTodayHours: (snoozeLaterTodayHours) => set({ snoozeLaterTodayHours }),
  setSnoozeWeekendDay: (snoozeWeekendDay) => set({ snoozeWeekendDay }),
  setSnoozeWeekStartDay: (snoozeWeekStartDay) => set({ snoozeWeekStartDay }),
  hydrateSnooze: (partial) => set(partial),
```

- [ ] **Step 6: Extend the complete UiState literal in MessageListPane.test**

Add these members to the same `const state: UiState = { ... }` literal in `src/features/message-list/MessageListPane.test.tsx` (extended for General in Task 1):

```ts
      snoozeMorningHour: 8,
      snoozeLaterTodayHours: 3,
      snoozeWeekendDay: 6,
      snoozeWeekStartDay: 1,
      setSnoozeMorningHour: vi.fn(),
      setSnoozeLaterTodayHours: vi.fn(),
      setSnoozeWeekendDay: vi.fn(),
      setSnoozeWeekStartDay: vi.fn(),
      hydrateSnooze: vi.fn(),
```

- [ ] **Step 7: Verify suite + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run && npm run build`
Expected: all PASS (incl. existing `SnoozePicker.test.tsx`, which uses the real store with the new defaults); build clean.

- [ ] **Step 8: Commit**

```bash
git add src/shared/snooze/snooze.ts src/shared/snooze/snooze.test.ts src/app/store.ts src/features/snooze/SnoozePicker.tsx src/features/message-list/MessageListPane.test.tsx
git commit -m "feat(snooze): configurable preset times via settings store"
```

---

### Task 3: datetime module + time-format-aware formatters

**Files:**
- Create: `src/shared/datetime/datetime.ts`
- Create: `src/shared/datetime/datetime.test.ts`
- Modify: `src/shared/snooze/snooze.ts` (remove `formatWakeTime`)
- Modify: `src/shared/snooze/snooze.test.ts` (drop the `formatWakeTime` import + test)
- Modify: `src/features/message-list/MessageListPane.tsx`
- Modify: `src/features/reader/ConversationView.tsx`

**Interfaces:**
- Consumes: `TimeFormat` from `../general/general`.
- Note: `MessageListPane.test.tsx`'s `UiState` literal already carries `timeFormat: "system"` (added in Task 1), so the rows reading `useUiStore((s) => s.timeFormat)` need no further test change.
- Produces: `hour12Option(fmt: TimeFormat): boolean | undefined`; `formatMessageTime(epochSeconds: number, fmt: TimeFormat): string`; `formatListDate(epochSeconds: number, fmt: TimeFormat): string`; `formatWakeTime(epochSeconds: number, fmt: TimeFormat): string`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/datetime/datetime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hour12Option, formatMessageTime, formatListDate, formatWakeTime } from "./datetime";

const TWO_PM = new Date(2026, 5, 19, 14, 30, 0);
const ts = Math.floor(TWO_PM.getTime() / 1000);

describe("hour12Option", () => {
  it("maps formats to the Intl hour12 flag", () => {
    expect(hour12Option("system")).toBeUndefined();
    expect(hour12Option("12h")).toBe(true);
    expect(hour12Option("24h")).toBe(false);
  });
});

describe("formatMessageTime", () => {
  it("renders 24-hour clock for 24h", () => {
    expect(formatMessageTime(ts, "24h")).toContain("14");
  });

  it("does not render a 24-hour hour for 12h", () => {
    expect(formatMessageTime(ts, "12h")).not.toContain("14");
  });

  it("returns a non-empty string for system", () => {
    expect(formatMessageTime(ts, "system").length).toBeGreaterThan(0);
  });
});

describe("formatListDate", () => {
  it("shows a time for today's date", () => {
    const todayTwoPm = new Date();
    todayTwoPm.setHours(14, 30, 0, 0);
    const out = formatListDate(Math.floor(todayTwoPm.getTime() / 1000), "24h");
    expect(out).toContain("14");
  });

  it("shows a month/day for older dates regardless of format", () => {
    const out = formatListDate(ts, "12h");
    expect(out).not.toContain("14");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("formatWakeTime", () => {
  it("returns a non-empty string and honours 24h", () => {
    expect(formatWakeTime(ts, "24h")).toContain("14");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/datetime/datetime.test.ts`
Expected: FAIL — cannot resolve `./datetime`.

- [ ] **Step 3: Create the datetime module**

Create `src/shared/datetime/datetime.ts`:

```ts
import type { TimeFormat } from "../general/general";

export function hour12Option(fmt: TimeFormat): boolean | undefined {
  if (fmt === "12h") return true;
  if (fmt === "24h") return false;
  return undefined;
}

export function formatMessageTime(epochSeconds: number, fmt: TimeFormat): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12Option(fmt),
  });
}

export function formatListDate(epochSeconds: number, fmt: TimeFormat): string {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: hour12Option(fmt),
    });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatWakeTime(epochSeconds: number, fmt: TimeFormat): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12Option(fmt),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/datetime/datetime.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove formatWakeTime from snooze.ts and its test**

In `src/shared/snooze/snooze.ts`, delete the `formatWakeTime` function (the final block, lines 40–47).

In `src/shared/snooze/snooze.test.ts`, remove `formatWakeTime` from the import list and delete the `it("formatWakeTime returns a non-empty string", ...)` test.

- [ ] **Step 6: Refactor MessageListPane to use datetime + store timeFormat**

In `src/features/message-list/MessageListPane.tsx`:

Replace the import on line 5:

```ts
import { formatWakeTime } from "../../shared/snooze/snooze";
```

with:

```ts
import { formatListDate, formatWakeTime } from "../../shared/datetime/datetime";
```

Delete the module-level `formatDate` function (lines 23–35).

In the `ThreadRow` component body, add as the first line of the function body (before `const isUnread = ...`):

```ts
  const timeFormat = useUiStore((s) => s.timeFormat);
```

and change the date span (was `{formatDate(thread.last_date)}`):

```tsx
          <span className="message-row__date">{formatListDate(thread.last_date, timeFormat)}</span>
```

In the `SmartRow` component body, add as the first line of the function body (before `const senderLabel = ...`):

```ts
  const timeFormat = useUiStore((s) => s.timeFormat);
```

change the date span (was `{formatDate(row.date)}`):

```tsx
          <span className="message-row__date">{formatListDate(row.date, timeFormat)}</span>
```

and change the snooze wake span (was `{formatWakeTime(wakeAt)}`):

```tsx
                {formatWakeTime(wakeAt, timeFormat)}
```

- [ ] **Step 7: Refactor ConversationView to use datetime + store timeFormat**

In `src/features/reader/ConversationView.tsx`:

Delete the module-level `formatTime` function (lines 10–12) and add an import after the existing imports:

```ts
import { formatMessageTime } from "../../shared/datetime/datetime";
```

In the `ConversationView` component body, add (alongside the other `useUiStore` reads):

```ts
  const timeFormat = useUiStore((s) => s.timeFormat);
```

Change the time span (was `{formatTime(m.date)}`):

```tsx
                <span className="reader__sender-time">{formatMessageTime(m.date, timeFormat)}</span>
```

- [ ] **Step 8: Verify suite + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run && npm run build`
Expected: all PASS; build clean. Pay attention to `ConversationView.test.tsx` and `MessageListPane.test.tsx` (the latter renders the refactored rows; its store mock already provides `timeFormat`).

- [ ] **Step 9: Commit**

```bash
git add src/shared/datetime/datetime.ts src/shared/datetime/datetime.test.ts src/shared/snooze/snooze.ts src/shared/snooze/snooze.test.ts src/features/message-list/MessageListPane.tsx src/features/reader/ConversationView.tsx
git commit -m "feat(settings): time-format-aware date formatting"
```

---

### Task 4: GeneralProvider + SnoozeProvider + mount

**Files:**
- Create: `src/shared/general/GeneralProvider.tsx`
- Create: `src/shared/general/GeneralProvider.test.tsx`
- Create: `src/shared/snooze/SnoozeProvider.tsx`
- Create: `src/shared/snooze/SnoozeProvider.test.tsx`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: store slices from Tasks 1–2; `GENERAL_KEYS`/`parseGeneralSettings`; `SNOOZE_KEYS`/`parseSnoozeSettings`; `commands.getSettings`/`commands.setSetting`.
- Produces: `GeneralProvider`, `useGeneral(): { defaultAccountId; timeFormat; setDefaultAccountId; setTimeFormat }`; `SnoozeProvider`, `useSnoozeSettings(): { morningHour; laterTodayHours; weekendDay; weekStartDay; setMorningHour; setLaterTodayHours; setWeekendDay; setWeekStartDay }`.

- [ ] **Step 1: Write the failing GeneralProvider test**

Create `src/shared/general/GeneralProvider.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const getSettings = vi.fn();
const setSetting = vi.fn().mockResolvedValue({ status: "ok", data: null });

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: () => getSettings(),
    setSetting: (k: string, v: string) => setSetting(k, v),
  },
}));

import { GeneralProvider, useGeneral } from "./GeneralProvider";
import { useUiStore } from "../../app/store";

function Probe() {
  const g = useGeneral();
  return (
    <div>
      <span data-testid="tf">{g.timeFormat}</span>
      <span data-testid="acc">{g.defaultAccountId}</span>
      <button onClick={() => g.setTimeFormat("24h")}>set-24h</button>
      <button onClick={() => g.setDefaultAccountId("5")}>set-acc</button>
    </div>
  );
}

afterEach(() => cleanup());

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({
    status: "ok",
    data: [["general.timeFormat", "12h"], ["general.defaultAccountId", "3"]],
  });
  setSetting.mockClear();
  useUiStore.setState({ defaultAccountId: "", timeFormat: "system", generalHydrated: false });
});

describe("GeneralProvider", () => {
  it("hydrates the store from getSettings on mount", async () => {
    render(<GeneralProvider><Probe /></GeneralProvider>);
    await waitFor(() => expect(screen.getByTestId("tf").textContent).toBe("12h"));
    expect(screen.getByTestId("acc").textContent).toBe("3");
    expect(useUiStore.getState().generalHydrated).toBe(true);
  });

  it("setTimeFormat persists via setSetting", async () => {
    render(<GeneralProvider><Probe /></GeneralProvider>);
    await waitFor(() => expect(screen.getByTestId("tf").textContent).toBe("12h"));
    fireEvent.click(screen.getByText("set-24h"));
    await waitFor(() => expect(screen.getByTestId("tf").textContent).toBe("24h"));
    expect(setSetting).toHaveBeenCalledWith("general.timeFormat", "24h");
  });

  it("setDefaultAccountId persists via setSetting", async () => {
    render(<GeneralProvider><Probe /></GeneralProvider>);
    await waitFor(() => expect(screen.getByTestId("acc").textContent).toBe("3"));
    fireEvent.click(screen.getByText("set-acc"));
    expect(setSetting).toHaveBeenCalledWith("general.defaultAccountId", "5");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/general/GeneralProvider.test.tsx`
Expected: FAIL — cannot resolve `./GeneralProvider`.

- [ ] **Step 3: Create GeneralProvider**

Create `src/shared/general/GeneralProvider.tsx`:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { GENERAL_KEYS, parseGeneralSettings, type TimeFormat } from "./general";

type GeneralContextValue = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
  setDefaultAccountId: (value: string) => void;
  setTimeFormat: (value: TimeFormat) => void;
};

const GeneralContext = createContext<GeneralContextValue | null>(null);

function persist(key: string, value: string) {
  void commands.setSetting(key, value).catch(() => undefined);
}

export function GeneralProvider({ children }: { children: ReactNode }) {
  const defaultAccountId = useUiStore((s) => s.defaultAccountId);
  const timeFormat = useUiStore((s) => s.timeFormat);
  const hydrateGeneral = useUiStore((s) => s.hydrateGeneral);
  const storeSetDefaultAccountId = useUiStore((s) => s.setDefaultAccountId);
  const storeSetTimeFormat = useUiStore((s) => s.setTimeFormat);

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (!active) return;
        hydrateGeneral(res.status === "ok" ? parseGeneralSettings(res.data) : {});
      })
      .catch(() => {
        if (active) hydrateGeneral({});
      });
    return () => {
      active = false;
    };
  }, [hydrateGeneral]);

  const value = useMemo<GeneralContextValue>(
    () => ({
      defaultAccountId,
      timeFormat,
      setDefaultAccountId: (v) => {
        storeSetDefaultAccountId(v);
        persist(GENERAL_KEYS.defaultAccountId, v);
      },
      setTimeFormat: (v) => {
        storeSetTimeFormat(v);
        persist(GENERAL_KEYS.timeFormat, v);
      },
    }),
    [defaultAccountId, timeFormat, storeSetDefaultAccountId, storeSetTimeFormat]
  );

  return <GeneralContext.Provider value={value}>{children}</GeneralContext.Provider>;
}

export function useGeneral(): GeneralContextValue {
  const ctx = useContext(GeneralContext);
  if (!ctx) throw new Error("useGeneral must be used within GeneralProvider");
  return ctx;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/general/GeneralProvider.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing SnoozeProvider test**

Create `src/shared/snooze/SnoozeProvider.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const getSettings = vi.fn();
const setSetting = vi.fn().mockResolvedValue({ status: "ok", data: null });

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: () => getSettings(),
    setSetting: (k: string, v: string) => setSetting(k, v),
  },
}));

import { SnoozeProvider, useSnoozeSettings } from "./SnoozeProvider";
import { useUiStore } from "../../app/store";

function Probe() {
  const s = useSnoozeSettings();
  return (
    <div>
      <span data-testid="mh">{s.morningHour}</span>
      <button onClick={() => s.setMorningHour(6)}>set-mh</button>
    </div>
  );
}

afterEach(() => cleanup());

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({
    status: "ok",
    data: [["snooze.morningHour", "7"]],
  });
  setSetting.mockClear();
  useUiStore.setState({
    snoozeMorningHour: 8,
    snoozeLaterTodayHours: 3,
    snoozeWeekendDay: 6,
    snoozeWeekStartDay: 1,
  });
});

describe("SnoozeProvider", () => {
  it("hydrates the store from getSettings on mount", async () => {
    render(<SnoozeProvider><Probe /></SnoozeProvider>);
    await waitFor(() => expect(screen.getByTestId("mh").textContent).toBe("7"));
  });

  it("setMorningHour persists via setSetting", async () => {
    render(<SnoozeProvider><Probe /></SnoozeProvider>);
    await waitFor(() => expect(screen.getByTestId("mh").textContent).toBe("7"));
    fireEvent.click(screen.getByText("set-mh"));
    await waitFor(() => expect(screen.getByTestId("mh").textContent).toBe("6"));
    expect(setSetting).toHaveBeenCalledWith("snooze.morningHour", "6");
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/snooze/SnoozeProvider.test.tsx`
Expected: FAIL — cannot resolve `./SnoozeProvider`.

- [ ] **Step 7: Create SnoozeProvider**

Create `src/shared/snooze/SnoozeProvider.tsx`:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { SNOOZE_KEYS, parseSnoozeSettings } from "./snooze";

type SnoozeContextValue = {
  morningHour: number;
  laterTodayHours: number;
  weekendDay: number;
  weekStartDay: number;
  setMorningHour: (value: number) => void;
  setLaterTodayHours: (value: number) => void;
  setWeekendDay: (value: number) => void;
  setWeekStartDay: (value: number) => void;
};

const SnoozeContext = createContext<SnoozeContextValue | null>(null);

function persist(key: string, value: number) {
  void commands.setSetting(key, String(value)).catch(() => undefined);
}

export function SnoozeProvider({ children }: { children: ReactNode }) {
  const morningHour = useUiStore((s) => s.snoozeMorningHour);
  const laterTodayHours = useUiStore((s) => s.snoozeLaterTodayHours);
  const weekendDay = useUiStore((s) => s.snoozeWeekendDay);
  const weekStartDay = useUiStore((s) => s.snoozeWeekStartDay);
  const hydrateSnooze = useUiStore((s) => s.hydrateSnooze);
  const storeSetMorningHour = useUiStore((s) => s.setSnoozeMorningHour);
  const storeSetLaterTodayHours = useUiStore((s) => s.setSnoozeLaterTodayHours);
  const storeSetWeekendDay = useUiStore((s) => s.setSnoozeWeekendDay);
  const storeSetWeekStartDay = useUiStore((s) => s.setSnoozeWeekStartDay);

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (!active) return;
        if (res.status === "ok") hydrateSnooze(parseSnoozeSettings(res.data));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrateSnooze]);

  const value = useMemo<SnoozeContextValue>(
    () => ({
      morningHour,
      laterTodayHours,
      weekendDay,
      weekStartDay,
      setMorningHour: (v) => {
        storeSetMorningHour(v);
        persist(SNOOZE_KEYS.morningHour, v);
      },
      setLaterTodayHours: (v) => {
        storeSetLaterTodayHours(v);
        persist(SNOOZE_KEYS.laterTodayHours, v);
      },
      setWeekendDay: (v) => {
        storeSetWeekendDay(v);
        persist(SNOOZE_KEYS.weekendDay, v);
      },
      setWeekStartDay: (v) => {
        storeSetWeekStartDay(v);
        persist(SNOOZE_KEYS.weekStartDay, v);
      },
    }),
    [
      morningHour,
      laterTodayHours,
      weekendDay,
      weekStartDay,
      storeSetMorningHour,
      storeSetLaterTodayHours,
      storeSetWeekendDay,
      storeSetWeekStartDay,
    ]
  );

  return <SnoozeContext.Provider value={value}>{children}</SnoozeContext.Provider>;
}

export function useSnoozeSettings(): SnoozeContextValue {
  const ctx = useContext(SnoozeContext);
  if (!ctx) throw new Error("useSnoozeSettings must be used within SnoozeProvider");
  return ctx;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/shared/snooze/SnoozeProvider.test.tsx`
Expected: PASS.

- [ ] **Step 9: Mount both providers in main.tsx**

In `src/main.tsx`, add imports after the NotificationsProvider import (line 5):

```tsx
import { GeneralProvider } from "./shared/general/GeneralProvider";
import { SnoozeProvider } from "./shared/snooze/SnoozeProvider";
```

Wrap the tree so the new providers sit inside `AppearanceProvider` and around `ShortcutsProvider` (final tree):

```tsx
    <QueryProvider>
      <AppearanceProvider>
        <NotificationsProvider>
          <GeneralProvider>
            <SnoozeProvider>
              <ShortcutsProvider>
                <App />
              </ShortcutsProvider>
            </SnoozeProvider>
          </GeneralProvider>
        </NotificationsProvider>
      </AppearanceProvider>
    </QueryProvider>
```

- [ ] **Step 10: Verify suite + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run && npm run build`
Expected: all PASS; build clean.

- [ ] **Step 11: Commit**

```bash
git add src/shared/general/GeneralProvider.tsx src/shared/general/GeneralProvider.test.tsx src/shared/snooze/SnoozeProvider.tsx src/shared/snooze/SnoozeProvider.test.tsx src/main.tsx
git commit -m "feat(settings): general and snooze settings providers"
```

---

### Task 5: GeneralSection + SnoozeSection + SettingsOverlay wiring

**Files:**
- Create: `src/features/settings/GeneralSection.tsx`
- Create: `src/features/settings/GeneralSection.test.tsx`
- Create: `src/features/settings/SnoozeSection.tsx`
- Create: `src/features/settings/SnoozeSection.test.tsx`
- Modify: `src/features/settings/SettingsOverlay.tsx`
- Modify: `src/features/settings/SettingsOverlay.test.tsx`

**Interfaces:**
- Consumes: `useGeneral` (Task 4), `useSnoozeSettings` (Task 4), `TIME_FORMATS` (Task 1), `useAccounts` (existing, returns `{ data?: Account[] }`, `Account.id: number`, `Account.email: string`).
- Produces: `GeneralSection`, `SnoozeSection` components. Reuses existing CSS classes `appearance-section`, `appearance-section__intro`, `appearance-field__label`, `theme-cards`, `theme-card`, `theme-card--active` (no new CSS).

- [ ] **Step 1: Write the failing GeneralSection test**

Create `src/features/settings/GeneralSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";

const { setDefaultAccountId, setTimeFormat } = vi.hoisted(() => ({
  setDefaultAccountId: vi.fn(),
  setTimeFormat: vi.fn(),
}));

vi.mock("../../shared/general/GeneralProvider", () => ({
  useGeneral: () => ({
    defaultAccountId: "",
    timeFormat: "system",
    setDefaultAccountId,
    setTimeFormat,
  }),
}));

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({
    data: [
      { id: 3, email: "a@example.com", display_name: "A", provider_type: "imap_password", color: null, position: 0, requires_reauth: false },
      { id: 5, email: "b@example.com", display_name: "B", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
    ],
  }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("GeneralSection", () => {
  it("lists accounts plus the automatic option", () => {
    const { getByLabelText } = render(<GeneralSection />);
    const select = getByLabelText("Default account") as HTMLSelectElement;
    expect(select.options.length).toBe(3);
    expect(select.options[0].value).toBe("");
    expect(select.options[1].value).toBe("3");
  });

  it("persists a chosen default account", () => {
    const { getByLabelText } = render(<GeneralSection />);
    fireEvent.change(getByLabelText("Default account"), { target: { value: "5" } });
    expect(setDefaultAccountId).toHaveBeenCalledWith("5");
  });

  it("persists a chosen time format", () => {
    const { getByText } = render(<GeneralSection />);
    fireEvent.click(getByText("24-hour"));
    expect(setTimeFormat).toHaveBeenCalledWith("24h");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/settings/GeneralSection.test.tsx`
Expected: FAIL — cannot resolve `./GeneralSection`.

- [ ] **Step 3: Create GeneralSection**

Create `src/features/settings/GeneralSection.tsx`:

```tsx
import { useGeneral } from "../../shared/general/GeneralProvider";
import { TIME_FORMATS } from "../../shared/general/general";
import { useAccounts } from "../../ipc/queries";

export function GeneralSection() {
  const g = useGeneral();
  const { data: accounts = [] } = useAccounts();

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">General application preferences.</p>

      <div className="appearance-field__label">Default account</div>
      <select
        aria-label="Default account"
        value={g.defaultAccountId}
        onChange={(e) => g.setDefaultAccountId(e.target.value)}
      >
        <option value="">Automatic (first account)</option>
        {accounts.map((a) => (
          <option key={a.id} value={String(a.id)}>
            {a.email}
          </option>
        ))}
      </select>

      <div className="appearance-field__label">Time format</div>
      <div className="theme-cards">
        {TIME_FORMATS.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={g.timeFormat === t.value}
            className={`theme-card${g.timeFormat === t.value ? " theme-card--active" : ""}`}
            onClick={() => g.setTimeFormat(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/settings/GeneralSection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing SnoozeSection test**

Create `src/features/settings/SnoozeSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { SnoozeSection } from "./SnoozeSection";

const { setMorningHour, setLaterTodayHours, setWeekendDay, setWeekStartDay } = vi.hoisted(() => ({
  setMorningHour: vi.fn(),
  setLaterTodayHours: vi.fn(),
  setWeekendDay: vi.fn(),
  setWeekStartDay: vi.fn(),
}));

vi.mock("../../shared/snooze/SnoozeProvider", () => ({
  useSnoozeSettings: () => ({
    morningHour: 8,
    laterTodayHours: 3,
    weekendDay: 6,
    weekStartDay: 1,
    setMorningHour,
    setLaterTodayHours,
    setWeekendDay,
    setWeekStartDay,
  }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("SnoozeSection", () => {
  it("reflects the current config", () => {
    const { getByLabelText } = render(<SnoozeSection />);
    expect((getByLabelText("Morning hour") as HTMLSelectElement).value).toBe("8");
    expect((getByLabelText("Later today offset") as HTMLSelectElement).value).toBe("3");
    expect((getByLabelText("Weekend day") as HTMLSelectElement).value).toBe("6");
    expect((getByLabelText("Start of week") as HTMLSelectElement).value).toBe("1");
  });

  it("persists each changed control", () => {
    const { getByLabelText } = render(<SnoozeSection />);
    fireEvent.change(getByLabelText("Morning hour"), { target: { value: "6" } });
    expect(setMorningHour).toHaveBeenCalledWith(6);
    fireEvent.change(getByLabelText("Later today offset"), { target: { value: "4" } });
    expect(setLaterTodayHours).toHaveBeenCalledWith(4);
    fireEvent.change(getByLabelText("Weekend day"), { target: { value: "0" } });
    expect(setWeekendDay).toHaveBeenCalledWith(0);
    fireEvent.change(getByLabelText("Start of week"), { target: { value: "2" } });
    expect(setWeekStartDay).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/settings/SnoozeSection.test.tsx`
Expected: FAIL — cannot resolve `./SnoozeSection`.

- [ ] **Step 7: Create SnoozeSection**

Create `src/features/settings/SnoozeSection.tsx`:

```tsx
import { useSnoozeSettings } from "../../shared/snooze/SnoozeProvider";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const OFFSETS = [1, 2, 3, 4, 6, 8, 12];
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

export function SnoozeSection() {
  const s = useSnoozeSettings();

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">Tune the snooze preset times.</p>

      <div className="appearance-field__label">Morning hour</div>
      <select
        aria-label="Morning hour"
        value={s.morningHour}
        onChange={(e) => s.setMorningHour(Number(e.target.value))}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, "0")}:00
          </option>
        ))}
      </select>

      <div className="appearance-field__label">"Later today" offset</div>
      <select
        aria-label="Later today offset"
        value={s.laterTodayHours}
        onChange={(e) => s.setLaterTodayHours(Number(e.target.value))}
      >
        {OFFSETS.map((h) => (
          <option key={h} value={h}>
            {h} hours
          </option>
        ))}
      </select>

      <div className="appearance-field__label">Weekend day</div>
      <select
        aria-label="Weekend day"
        value={s.weekendDay}
        onChange={(e) => s.setWeekendDay(Number(e.target.value))}
      >
        {WEEKDAYS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>

      <div className="appearance-field__label">Start of week</div>
      <select
        aria-label="Start of week"
        value={s.weekStartDay}
        onChange={(e) => s.setWeekStartDay(Number(e.target.value))}
      >
        {WEEKDAYS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/settings/SnoozeSection.test.tsx`
Expected: PASS.

- [ ] **Step 9: Wire both sections into SettingsOverlay**

In `src/features/settings/SettingsOverlay.tsx`:

Add imports after the `SignaturesSection` import (line 7):

```tsx
import { GeneralSection } from "./GeneralSection";
import { SnoozeSection } from "./SnoozeSection";
```

Replace the render conditional (lines 75–87) with:

```tsx
          {active === "general" ? (
            <GeneralSection />
          ) : active === "appearance" ? (
            <AppearanceSection />
          ) : active === "labels" ? (
            <LabelsSection />
          ) : active === "signatures" ? (
            <SignaturesSection />
          ) : active === "notifications" ? (
            <NotificationsSection />
          ) : active === "snooze" ? (
            <SnoozeSection />
          ) : active === "shortcuts" ? (
            <ShortcutsSection />
          ) : (
            <div className="settings-placeholder">Coming soon</div>
          )}
```

- [ ] **Step 10: Update SettingsOverlay.test placeholder assertion**

`SettingsOverlay.test.tsx` wraps only in `AppearanceProvider` (no `GeneralProvider`/`SnoozeProvider`/`QueryClientProvider`). Its test `"switching to a non-appearance section shows a placeholder"` currently clicks **"General"**, which now renders the real `GeneralSection` (calls `useGeneral`/`useAccounts` → throws in this isolated test). Switch it to a still-placeholder section — **"Accounts"** (remaining placeholders: Accounts, Rules & Filters).

In that test, change:

```tsx
    fireEvent.click(screen.getByRole("button", { name: "General" }));
```

to:

```tsx
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
```

The `expect(screen.getByText(/coming soon/i))` assertion stays. No other test in this file navigates into General/Snooze, so no provider/QueryClient wrapping is needed.

- [ ] **Step 11: Verify suite + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run && npm run build`
Expected: all PASS (including `SettingsOverlay.test.tsx`); build clean.

- [ ] **Step 12: Commit**

```bash
git add src/features/settings/GeneralSection.tsx src/features/settings/GeneralSection.test.tsx src/features/settings/SnoozeSection.tsx src/features/settings/SnoozeSection.test.tsx src/features/settings/SettingsOverlay.tsx src/features/settings/SettingsOverlay.test.tsx
git commit -m "feat(settings): general and snooze settings sections"
```

---

### Task 6: Startup view — open the default account's Inbox

**Files:**
- Create: `src/features/startup/useStartupView.ts`
- Create: `src/features/startup/useStartupView.test.tsx`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/AppShell.test.tsx`

**Interfaces:**
- Consumes: `useAccounts(): { data?: Account[] }`; `useFolders(accountId: number | null): { data?: Folder[] }` where `Folder.folder_type: FolderType` and `Folder.id: number`; store fields `generalHydrated`, `defaultAccountId`, `selectedAccountId`, `selectedFolderId`, `selectedSmartFolder`, `selectedLabelId`, and setters `setSelectedAccountId`, `setSelectedFolderId`; `Account.id: number`, `Account.position: number`.
- Produces: `useStartupView(): void`.

- [ ] **Step 1: Write the failing test**

Create `src/features/startup/useStartupView.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";

const { useAccounts, useFolders } = vi.hoisted(() => ({
  useAccounts: vi.fn(),
  useFolders: vi.fn(),
}));

vi.mock("../../ipc/queries", () => ({ useAccounts, useFolders }));

import { useStartupView } from "./useStartupView";
import { useUiStore } from "../../app/store";

const ACCOUNTS = [
  { id: 2, email: "b@x.com", display_name: "B", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
  { id: 5, email: "a@x.com", display_name: "A", provider_type: "imap_password", color: null, position: 0, requires_reauth: false },
];

const FOLDERS = [
  { id: 30, account_id: 2, remote_path: "INBOX", name: "Inbox", folder_type: "inbox", unread_count: 0, total_count: 0 },
  { id: 31, account_id: 2, remote_path: "Sent", name: "Sent", folder_type: "sent", unread_count: 0, total_count: 0 },
];

function Harness() {
  useStartupView();
  return null;
}

beforeEach(() => {
  useAccounts.mockReset();
  useFolders.mockReset().mockReturnValue({ data: undefined });
  useUiStore.setState({
    selectedAccountId: null,
    selectedFolderId: null,
    selectedSmartFolder: null,
    selectedLabelId: null,
    defaultAccountId: "",
    generalHydrated: false,
  });
});

afterEach(() => cleanup());

describe("useStartupView", () => {
  it("opens the explicit default account's inbox", async () => {
    useAccounts.mockReturnValue({ data: ACCOUNTS });
    useFolders.mockImplementation((id: number | null) => ({ data: id === 2 ? FOLDERS : undefined }));
    useUiStore.setState({ defaultAccountId: "2", generalHydrated: true });

    render(<Harness />);

    await waitFor(() => expect(useUiStore.getState().selectedAccountId).toBe(2));
    await waitFor(() => expect(useUiStore.getState().selectedFolderId).toBe(30));
  });

  it("falls back to the first account by position when the default is missing", async () => {
    useAccounts.mockReturnValue({ data: ACCOUNTS });
    useFolders.mockImplementation((id: number | null) => ({ data: id === 5 ? FOLDERS : undefined }));
    useUiStore.setState({ defaultAccountId: "999", generalHydrated: true });

    render(<Harness />);

    await waitFor(() => expect(useUiStore.getState().selectedAccountId).toBe(5));
  });

  it("does nothing when a selection already exists", async () => {
    useAccounts.mockReturnValue({ data: ACCOUNTS });
    useUiStore.setState({ generalHydrated: true, selectedSmartFolder: "all_inboxes" });

    render(<Harness />);

    await new Promise((r) => setTimeout(r, 20));
    expect(useUiStore.getState().selectedAccountId).toBeNull();
  });

  it("does nothing while general settings are not hydrated", async () => {
    useAccounts.mockReturnValue({ data: ACCOUNTS });
    useUiStore.setState({ generalHydrated: false });

    render(<Harness />);

    await new Promise((r) => setTimeout(r, 20));
    expect(useUiStore.getState().selectedAccountId).toBeNull();
  });

  it("does nothing when there are no accounts", async () => {
    useAccounts.mockReturnValue({ data: [] });
    useUiStore.setState({ generalHydrated: true });

    render(<Harness />);

    await new Promise((r) => setTimeout(r, 20));
    expect(useUiStore.getState().selectedAccountId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/startup/useStartupView.test.tsx`
Expected: FAIL — cannot resolve `./useStartupView`.

- [ ] **Step 3: Create the hook**

Create `src/features/startup/useStartupView.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { useAccounts, useFolders } from "../../ipc/queries";
import { useUiStore } from "../../app/store";

export function useStartupView() {
  const { data: accounts } = useAccounts();
  const generalHydrated = useUiStore((s) => s.generalHydrated);
  const defaultAccountId = useUiStore((s) => s.defaultAccountId);
  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const selectedLabelId = useUiStore((s) => s.selectedLabelId);
  const setSelectedAccountId = useUiStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);

  const phase = useRef<"idle" | "account-set" | "done">("idle");
  const [bootAccountId, setBootAccountId] = useState<number | null>(null);
  const { data: folders } = useFolders(bootAccountId);

  useEffect(() => {
    if (phase.current !== "idle") return;
    if (!generalHydrated) return;
    if (!accounts) return;
    const hasSelection =
      selectedAccountId !== null ||
      selectedFolderId !== null ||
      selectedSmartFolder !== null ||
      selectedLabelId !== null;
    if (hasSelection) {
      phase.current = "done";
      return;
    }
    if (accounts.length === 0) return;
    const explicit = defaultAccountId
      ? accounts.find((a) => String(a.id) === defaultAccountId)
      : undefined;
    const resolved = explicit ?? [...accounts].sort((a, b) => a.position - b.position)[0];
    phase.current = "account-set";
    setBootAccountId(resolved.id);
    setSelectedAccountId(resolved.id);
  }, [
    generalHydrated,
    accounts,
    defaultAccountId,
    selectedAccountId,
    selectedFolderId,
    selectedSmartFolder,
    selectedLabelId,
    setSelectedAccountId,
  ]);

  useEffect(() => {
    if (phase.current !== "account-set") return;
    if (!folders) return;
    const inbox = folders.find((f) => f.folder_type === "inbox");
    if (inbox) setSelectedFolderId(inbox.id);
    phase.current = "done";
  }, [folders, setSelectedFolderId]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/startup/useStartupView.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Mount the hook in AppShell**

In `src/app/AppShell.tsx`, add an import:

```ts
import { useStartupView } from "../features/startup/useStartupView";
```

and call it at the top of the `AppShell` component body, right after `useSyncEvents();`:

```ts
  useSyncEvents();
  useStartupView();
```

- [ ] **Step 6: Mock the hook in AppShell.test**

In `src/app/AppShell.test.tsx`, add a mock alongside the other `vi.mock` calls:

```ts
vi.mock("../features/startup/useStartupView", () => ({
  useStartupView: vi.fn(),
}));
```

(Optional but recommended — add `timeFormat: "system"`, `defaultAccountId: ""`, `generalHydrated: true`, `snoozeMorningHour: 8`, `snoozeLaterTodayHours: 3`, `snoozeWeekendDay: 6`, `snoozeWeekStartDay: 1` to the manual `useUiStore` state object in this test for representativeness.)

- [ ] **Step 7: Verify suite + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run && npm run build`
Expected: all PASS; build clean.

- [ ] **Step 8: Commit**

```bash
git add src/features/startup/useStartupView.ts src/features/startup/useStartupView.test.tsx src/app/AppShell.tsx src/app/AppShell.test.tsx
git commit -m "feat(settings): open default account inbox on startup"
```

---

## Final verification (after all tasks)

Run the whole suite and the production build once more:

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run
npm run build
```

Expected: all frontend tests green; `npm run build` clean (no TS6133 unused-import / TS2741 incomplete-literal errors). No Rust, migration, or bindings changes were made.
