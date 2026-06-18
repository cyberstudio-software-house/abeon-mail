# Etap 6a — Appearance + szkielet Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać trwały (SQLite) store ustawień wyglądu i pełnoekranowy ekran Settings z funkcjonalną sekcją Appearance (theme, accent, density, preview-text, avatary), portowany 1:1 z szablonu.

**Architecture:** Backend trzyma ustawienia w tabeli key-value `settings` (migracja V6) z `settings_repo` + dwiema komendami Tauri. Frontend: czyste pola wyglądu w `useUiStore`, `AppearanceProvider` ładuje ustawienia raz i aplikuje do DOM (`data-theme`, `--accent`), hook `useAppearance` udostępnia settery zapisujące przez komendy. Ekran Settings to overlay (wzorzec jak Composer) z sidebar-nav; w 6a funkcjonalna jest tylko sekcja Appearance.

**Tech Stack:** Rust (rusqlite, refinery, tauri-specta), React 19 + TypeScript, zustand, @tanstack/react-virtual, vitest + @testing-library/react.

## Global Constraints

- Wszystkie identyfikatory w kodzie po angielsku; **bez komentarzy w kodzie** (dokumentacja w `docs/`).
- Commity: Conventional Commits, **bez** dopisywania współautora; **bez** `git push`.
- Node 24 (`$HOME/.nvm/versions/node/v24.14.0/bin`); frontend testy: `npm test` (vitest run).
- Źródło wizualne: `docs/templates/AbeonMail Screens.html` — każdy element UI portowany wiernie; ostatni krok to fidelity check.
- Migracje refinery: pliki `crates/am-storage/src/migrations/Vn__*.sql`, kolejny numer to **V6**.
- Bindings generowane: `npm run gen:bindings` (regeneruje `src/ipc/bindings.ts`).
- Accent presety (dokładne hexy z szablonu): `#4f46e5` (domyślny), `#7c3aed`, `#0ea5e9`, `#10b981`, `#ef5d3a`, `#ec4899`.
- Density: trzy poziomy `comfortable` | `compact` | `dense`.
- Klucze ustawień: `appearance.theme`, `appearance.accent`, `appearance.density`, `appearance.showPreview`, `appearance.showAvatars`.

---

### Task 1: Migracja V6 + settings_repo (backend)

**Files:**
- Create: `crates/am-storage/src/migrations/V6__settings.sql`
- Create: `crates/am-storage/src/settings_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (dodać `pub mod settings_repo;`)

**Interfaces:**
- Produces:
  - `settings_repo::get_setting(db: &Database, key: &str) -> Result<Option<String>, StorageError>`
  - `settings_repo::set_setting(db: &Database, key: &str, value: &str) -> Result<(), StorageError>`
  - `settings_repo::get_all_settings(db: &Database) -> Result<Vec<(String, String)>, StorageError>`

- [ ] **Step 1: Migracja V6**

Create `crates/am-storage/src/migrations/V6__settings.sql`:

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

- [ ] **Step 2: Zarejestruj moduł repo**

Modify `crates/am-storage/src/lib.rs` — dodaj linię w bloku `pub mod` (alfabetycznie, po `queue_repo`):

```rust
pub mod settings_repo;
```

- [ ] **Step 3: Napisz failing testy repo**

Create `crates/am-storage/src/settings_repo.rs`:

```rust
use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn get_setting(db: &Database, key: &str) -> Result<Option<String>, StorageError> {
    let conn = db.conn();
    let value = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| {
            row.get::<_, String>(0)
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(value)
}

pub fn set_setting(db: &Database, key: &str, value: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_all_settings(db: &Database) -> Result<Vec<(String, String)>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_missing_key_returns_none() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(get_setting(&db, "appearance.theme").unwrap(), None);
    }

    #[test]
    fn set_then_get_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        set_setting(&db, "appearance.theme", "dark").unwrap();
        assert_eq!(get_setting(&db, "appearance.theme").unwrap(), Some("dark".to_string()));
    }

    #[test]
    fn set_upserts_existing_key() {
        let db = Database::open_in_memory().unwrap();
        set_setting(&db, "appearance.density", "compact").unwrap();
        set_setting(&db, "appearance.density", "dense").unwrap();
        assert_eq!(get_setting(&db, "appearance.density").unwrap(), Some("dense".to_string()));
    }

    #[test]
    fn get_all_returns_every_pair_sorted() {
        let db = Database::open_in_memory().unwrap();
        set_setting(&db, "appearance.theme", "auto").unwrap();
        set_setting(&db, "appearance.accent", "#4f46e5").unwrap();
        let all = get_all_settings(&db).unwrap();
        assert_eq!(
            all,
            vec![
                ("appearance.accent".to_string(), "#4f46e5".to_string()),
                ("appearance.theme".to_string(), "auto".to_string()),
            ]
        );
    }
}
```

- [ ] **Step 4: Uruchom testy — mają przejść (repo + migracja kompiluje się)**

Run: `cargo test -p am-storage settings_repo`
Expected: PASS (4 testy). Jeśli migracja źle się aplikuje, testy `open_in_memory` zgłoszą błąd.

- [ ] **Step 5: Commit**

```bash
git add crates/am-storage/src/migrations/V6__settings.sql crates/am-storage/src/settings_repo.rs crates/am-storage/src/lib.rs
git commit -m "feat(storage): add settings key-value table (V6) and settings_repo"
```

---

### Task 2: Komendy Tauri get_settings / set_setting + bindings

**Files:**
- Modify: `crates/am-app/src/commands.rs` (dodać 2 komendy + import `settings_repo`)
- Modify: `crates/am-app/src/lib.rs` (rejestracja w `collect_commands!`)
- Modify (generowany): `src/ipc/bindings.ts` (przez `npm run gen:bindings`)

**Interfaces:**
- Consumes: `settings_repo::{get_all_settings, set_setting}` (Task 1), `AppState.db`.
- Produces (bindings): `commands.getSettings(): Promise<Result<[string,string][], string>>`, `commands.setSetting(key: string, value: string): Promise<Result<null, string>>`.

- [ ] **Step 1: Dodaj komendy**

Modify `crates/am-app/src/commands.rs` — w imporcie repo dopisz `settings_repo`:

```rust
use am_storage::{accounts_repo, drafts_repo, folders_repo, messages_repo, settings_repo, signatures_repo, smart_repo};
```

Dopisz na końcu pliku dwie komendy:

```rust
#[tauri::command]
#[specta::specta]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    settings_repo::get_all_settings(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_setting(state: tauri::State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    settings_repo::set_setting(&state.db, &key, &value).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Zarejestruj komendy**

Modify `crates/am-app/src/lib.rs` — w `collect_commands![ ... ]` dodaj na końcu listy (po `commands::list_smart_folder,`):

```rust
            commands::get_settings,
            commands::set_setting,
```

- [ ] **Step 3: Skompiluj backend**

Run: `cargo build -p abeonmail`
Expected: kompiluje się bez błędów.

- [ ] **Step 4: Regeneruj bindings**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` zaktualizowany.

- [ ] **Step 5: Zweryfikuj obecność komend w bindings**

Run: `grep -n "getSettings\|setSetting" src/ipc/bindings.ts`
Expected: znalezione obie nazwy (definicje w obiekcie `commands`).

- [ ] **Step 6: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(app): expose getSettings/setSetting commands"
```

---

### Task 3: Store wyglądu + stałe + helpery (frontend)

**Files:**
- Modify: `src/app/store.ts` (zawęź `Density`, dodaj pola wyglądu + settery + `hydrateAppearance`)
- Create: `src/shared/appearance/appearance.ts` (stałe + helpery + `parseSettings`)
- Create: `src/shared/appearance/appearance.test.ts`
- Modify: `src/app/store.test.ts` (zresetuj nowe pola w `beforeEach`, dodaj testy)
- Modify: `src/features/message-list/MessageListPane.tsx` (usuń `cozy` z `ROW_HEIGHT`)

**Interfaces:**
- Consumes: `ThemeMode` z `src/shared/theme/theme.ts`.
- Produces:
  - Store pola: `theme: ThemeMode`, `accent: string`, `density: Density`, `showPreview: boolean`, `showAvatars: boolean`
  - Store settery (czyste): `setTheme`, `setAccent`, `setDensity`, `setShowPreview`, `setShowAvatars`
  - `hydrateAppearance(partial: Partial<AppearanceFields>): void`
  - `appearance.ts`: `SETTINGS_KEYS`, `ACCENT_PRESETS`, `THEME_MODES`, `DENSITIES`, `DEFAULT_APPEARANCE`, `initials(s)`, `avatarColor(seed)`, `parseSettings(pairs)`

- [ ] **Step 1: Napisz failing testy helperów**

Create `src/shared/appearance/appearance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { initials, avatarColor, parseSettings, DEFAULT_APPEARANCE } from "./appearance";

describe("initials", () => {
  it("takes first letters of first two words", () => {
    expect(initials("Malak Frederick")).toBe("MF");
    expect(initials("Grover Cortez")).toBe("GC");
  });
  it("falls back to first two chars of a single token or email", () => {
    expect(initials("support@abeon.hosting")).toBe("SU");
    expect(initials("alice")).toBe("AL");
  });
  it("handles empty input", () => {
    expect(initials("")).toBe("?");
  });
});

describe("avatarColor", () => {
  it("is deterministic for the same seed", () => {
    expect(avatarColor("a@b.com")).toBe(avatarColor("a@b.com"));
  });
  it("returns a hex color from the palette", () => {
    expect(avatarColor("x@y.com")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("parseSettings", () => {
  it("maps known keys, ignores unknown, keeps defaults for missing", () => {
    const parsed = parseSettings([
      ["appearance.theme", "dark"],
      ["appearance.density", "compact"],
      ["appearance.showPreview", "false"],
      ["unknown.key", "whatever"],
    ]);
    expect(parsed.theme).toBe("dark");
    expect(parsed.density).toBe("compact");
    expect(parsed.showPreview).toBe(false);
    expect(parsed.accent).toBeUndefined();
  });
  it("rejects invalid enum values", () => {
    const parsed = parseSettings([["appearance.theme", "rainbow"]]);
    expect(parsed.theme).toBeUndefined();
  });
});

describe("DEFAULT_APPEARANCE", () => {
  it("defaults theme auto, accent indigo, density comfortable, toggles on", () => {
    expect(DEFAULT_APPEARANCE).toEqual({
      theme: "auto",
      accent: "#4f46e5",
      density: "comfortable",
      showPreview: true,
      showAvatars: true,
    });
  });
});
```

- [ ] **Step 2: Uruchom — fail (brak modułu)**

Run: `npm test -- src/shared/appearance/appearance.test.ts`
Expected: FAIL ("Cannot find module './appearance'").

- [ ] **Step 3: Zaimplementuj appearance.ts**

Create `src/shared/appearance/appearance.ts`:

```ts
import type { ThemeMode } from "../theme/theme";

export type Density = "comfortable" | "compact" | "dense";

export type AppearanceFields = {
  theme: ThemeMode;
  accent: string;
  density: Density;
  showPreview: boolean;
  showAvatars: boolean;
};

export const SETTINGS_KEYS = {
  theme: "appearance.theme",
  accent: "appearance.accent",
  density: "appearance.density",
  showPreview: "appearance.showPreview",
  showAvatars: "appearance.showAvatars",
} as const;

export const DEFAULT_APPEARANCE: AppearanceFields = {
  theme: "auto",
  accent: "#4f46e5",
  density: "comfortable",
  showPreview: true,
  showAvatars: true,
};

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
];

export const ACCENT_PRESETS: string[] = [
  "#4f46e5",
  "#7c3aed",
  "#0ea5e9",
  "#10b981",
  "#ef5d3a",
  "#ec4899",
];

export const DENSITIES: { value: Density; label: string; hint: string }[] = [
  { value: "comfortable", label: "Comfortable", hint: "Roomy rows" },
  { value: "compact", label: "Compact", hint: "More on screen" },
  { value: "dense", label: "Dense", hint: "Maximum rows" },
];

const AVATAR_PALETTE = [
  "#4f46e5",
  "#7c3aed",
  "#0ea5e9",
  "#10b981",
  "#ef5d3a",
  "#ec4899",
  "#f59e0b",
  "#0d9488",
];

export function initials(nameOrEmail: string): string {
  const trimmed = nameOrEmail.trim();
  if (!trimmed) return "?";
  const local = trimmed.split("@")[0];
  const words = local.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function isThemeMode(v: string): v is ThemeMode {
  return v === "light" || v === "dark" || v === "auto";
}

function isDensity(v: string): v is Density {
  return v === "comfortable" || v === "compact" || v === "dense";
}

export function parseSettings(pairs: [string, string][]): Partial<AppearanceFields> {
  const out: Partial<AppearanceFields> = {};
  for (const [key, value] of pairs) {
    switch (key) {
      case SETTINGS_KEYS.theme:
        if (isThemeMode(value)) out.theme = value;
        break;
      case SETTINGS_KEYS.accent:
        if (ACCENT_PRESETS.includes(value)) out.accent = value;
        break;
      case SETTINGS_KEYS.density:
        if (isDensity(value)) out.density = value;
        break;
      case SETTINGS_KEYS.showPreview:
        out.showPreview = value === "true";
        break;
      case SETTINGS_KEYS.showAvatars:
        out.showAvatars = value === "true";
        break;
      default:
        break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Uruchom — pass**

Run: `npm test -- src/shared/appearance/appearance.test.ts`
Expected: PASS.

- [ ] **Step 5: Rozszerz store o pola wyglądu**

Modify `src/app/store.ts`. Zmień import i typ `Density`, dodaj pola/settery. Pełna nowa zawartość pliku:

```ts
import { create } from "zustand";
import type { OutgoingMessage, SmartFolderKind } from "../ipc/bindings";
import type { ThemeMode } from "../shared/theme/theme";
import {
  DEFAULT_APPEARANCE,
  type AppearanceFields,
  type Density,
} from "../shared/appearance/appearance";

export type { Density };

type ComposerState = {
  open: boolean;
  draftId: number | null;
  prefill: OutgoingMessage | null;
};

export type UiState = {
  selectedAccountId: number | null;
  selectedFolderId: number | null;
  selectedMessageId: number | null;
  selectedThreadId: number | null;
  selectedSmartFolder: SmartFolderKind | null;
  theme: ThemeMode;
  accent: string;
  density: Density;
  showPreview: boolean;
  showAvatars: boolean;
  composer: ComposerState;
  setSelectedAccountId: (id: number | null) => void;
  setSelectedFolderId: (id: number | null) => void;
  setSelectedMessageId: (id: number | null) => void;
  setSelectedThreadId: (id: number | null) => void;
  setSelectedSmartFolder: (kind: SmartFolderKind | null) => void;
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: string) => void;
  setDensity: (density: Density) => void;
  setShowPreview: (value: boolean) => void;
  setShowAvatars: (value: boolean) => void;
  hydrateAppearance: (partial: Partial<AppearanceFields>) => void;
  openComposer: (draftId: number | null, prefill?: OutgoingMessage | null) => void;
  closeComposer: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedAccountId: null,
  selectedFolderId: null,
  selectedMessageId: null,
  selectedThreadId: null,
  selectedSmartFolder: null,
  theme: DEFAULT_APPEARANCE.theme,
  accent: DEFAULT_APPEARANCE.accent,
  density: DEFAULT_APPEARANCE.density,
  showPreview: DEFAULT_APPEARANCE.showPreview,
  showAvatars: DEFAULT_APPEARANCE.showAvatars,
  composer: { open: false, draftId: null, prefill: null },
  setSelectedAccountId: (id) =>
    set({ selectedAccountId: id, selectedSmartFolder: null }),
  setSelectedFolderId: (id) =>
    set({ selectedFolderId: id, selectedSmartFolder: null }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedThreadId: (id) => set({ selectedThreadId: id }),
  setSelectedSmartFolder: (kind) =>
    set({
      selectedSmartFolder: kind,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
    }),
  setTheme: (theme) => set({ theme }),
  setAccent: (accent) => set({ accent }),
  setDensity: (density) => set({ density }),
  setShowPreview: (showPreview) => set({ showPreview }),
  setShowAvatars: (showAvatars) => set({ showAvatars }),
  hydrateAppearance: (partial) => set(partial),
  openComposer: (draftId, prefill = null) =>
    set({ composer: { open: true, draftId, prefill } }),
  closeComposer: () =>
    set({ composer: { open: false, draftId: null, prefill: null } }),
}));
```

- [ ] **Step 6: Zaktualizuj store.test.ts (reset nowych pól + nowe testy)**

Modify `src/app/store.test.ts` — w `beforeEach` zamień obiekt `setState` tak, by resetował nowe pola, i dodaj blok testów wyglądu. Zmień `beforeEach`:

```ts
beforeEach(() => {
  useUiStore.setState({
    selectedAccountId: null,
    selectedFolderId: null,
    selectedMessageId: null,
    selectedThreadId: null,
    selectedSmartFolder: null,
    theme: "auto",
    accent: "#4f46e5",
    density: "comfortable",
    showPreview: true,
    showAvatars: true,
    composer: { open: false, draftId: null, prefill: null },
  });
});
```

Dodaj na końcu pliku:

```ts
describe("appearance state", () => {
  it("setters update individual appearance fields", () => {
    useUiStore.getState().setTheme("dark");
    useUiStore.getState().setAccent("#10b981");
    useUiStore.getState().setDensity("dense");
    useUiStore.getState().setShowPreview(false);
    useUiStore.getState().setShowAvatars(false);
    const s = useUiStore.getState();
    expect(s.theme).toBe("dark");
    expect(s.accent).toBe("#10b981");
    expect(s.density).toBe("dense");
    expect(s.showPreview).toBe(false);
    expect(s.showAvatars).toBe(false);
  });

  it("hydrateAppearance applies a partial without touching others", () => {
    useUiStore.getState().hydrateAppearance({ theme: "light", density: "compact" });
    const s = useUiStore.getState();
    expect(s.theme).toBe("light");
    expect(s.density).toBe("compact");
    expect(s.accent).toBe("#4f46e5");
  });
});
```

(Jeśli `describe`/`it`/`expect` nie są jeszcze importowane łącznie — plik już importuje je z `vitest`.)

- [ ] **Step 7: Usuń `cozy` z ROW_HEIGHT**

Modify `src/features/message-list/MessageListPane.tsx` — zmień mapę `ROW_HEIGHT`:

```ts
const ROW_HEIGHT: Record<Density, number> = {
  comfortable: 72,
  compact: 48,
  dense: 36,
};
```

- [ ] **Step 8: Uruchom testy frontu (store + appearance)**

Run: `npm test -- src/app/store.test.ts src/shared/appearance/appearance.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts src/shared/appearance/appearance.ts src/shared/appearance/appearance.test.ts src/features/message-list/MessageListPane.tsx
git commit -m "feat(ui): appearance state in store + presets/helpers; narrow density to 3 levels"
```

---

### Task 4: AppearanceProvider + useAppearance + montaż w main.tsx

**Files:**
- Create: `src/shared/appearance/AppearanceProvider.tsx`
- Create: `src/shared/appearance/AppearanceProvider.test.tsx`
- Modify: `src/main.tsx` (zamień `ThemeProvider` → `AppearanceProvider`)
- Delete: `src/shared/theme/ThemeProvider.tsx`
- Modify: `src/app/AppShell.test.tsx` (usuń nieaktualny mock `ThemeProvider`, dodaj pola wyglądu + `settingsOpen`/`openSettings`/`closeSettings` do mocka store)

**Interfaces:**
- Consumes: `commands.getSettings`/`commands.setSetting` (Task 2), store settery + `hydrateAppearance` (Task 3), `parseSettings`/`SETTINGS_KEYS` (Task 3), `resolveTheme` z `theme.ts`.
- Produces: `AppearanceProvider` (component), `useAppearance(): AppearanceFields & { setTheme, setAccent, setDensity, setShowPreview, setShowAvatars }` — settery aktualizują store i zapisują przez `setSetting` (fire-and-forget).

- [ ] **Step 1: Napisz failing test providera**

Create `src/shared/appearance/AppearanceProvider.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const getSettings = vi.fn();
const setSetting = vi.fn().mockResolvedValue({ status: "ok", data: null });

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: () => getSettings(),
    setSetting: (k: string, v: string) => setSetting(k, v),
  },
}));

import { AppearanceProvider, useAppearance } from "./AppearanceProvider";
import { useUiStore } from "../../app/store";

function Probe() {
  const a = useAppearance();
  return (
    <div>
      <span data-testid="theme">{a.theme}</span>
      <button onClick={() => a.setTheme("dark")}>set-dark</button>
    </div>
  );
}

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({
    status: "ok",
    data: [["appearance.theme", "light"]],
  });
  setSetting.mockClear();
  useUiStore.setState({ theme: "auto", accent: "#4f46e5", density: "comfortable", showPreview: true, showAvatars: true });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--accent");
});

describe("AppearanceProvider", () => {
  it("hydrates store from getSettings on mount", async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>
    );
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("light"));
  });

  it("applies data-theme and --accent to the document element", async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>
    );
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#4f46e5");
  });

  it("setTheme updates store and persists via setSetting", async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>
    );
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("light"));
    fireEvent.click(screen.getByText("set-dark"));
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("dark"));
    expect(setSetting).toHaveBeenCalledWith("appearance.theme", "dark");
  });
});
```

- [ ] **Step 2: Uruchom — fail (brak modułu)**

Run: `npm test -- src/shared/appearance/AppearanceProvider.test.tsx`
Expected: FAIL ("Cannot find module './AppearanceProvider'").

- [ ] **Step 3: Zaimplementuj AppearanceProvider**

Create `src/shared/appearance/AppearanceProvider.tsx`:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { resolveTheme, type ThemeMode } from "../theme/theme";
import {
  SETTINGS_KEYS,
  parseSettings,
  type AppearanceFields,
  type Density,
} from "./appearance";

type AppearanceContextValue = AppearanceFields & {
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: string) => void;
  setDensity: (density: Density) => void;
  setShowPreview: (value: boolean) => void;
  setShowAvatars: (value: boolean) => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function persist(key: string, value: string) {
  void commands.setSetting(key, value).catch(() => undefined);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const theme = useUiStore((s) => s.theme);
  const accent = useUiStore((s) => s.accent);
  const density = useUiStore((s) => s.density);
  const showPreview = useUiStore((s) => s.showPreview);
  const showAvatars = useUiStore((s) => s.showAvatars);
  const hydrateAppearance = useUiStore((s) => s.hydrateAppearance);
  const storeSetTheme = useUiStore((s) => s.setTheme);
  const storeSetAccent = useUiStore((s) => s.setAccent);
  const storeSetDensity = useUiStore((s) => s.setDensity);
  const storeSetShowPreview = useUiStore((s) => s.setShowPreview);
  const storeSetShowAvatars = useUiStore((s) => s.setShowAvatars);

  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (!active) return;
        if (res.status === "ok") {
          hydrateAppearance(parseSettings(res.data as [string, string][]));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrateAppearance]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(theme, prefersDark);
  }, [theme, prefersDark]);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", accent);
  }, [accent]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      theme,
      accent,
      density,
      showPreview,
      showAvatars,
      setTheme: (t) => {
        storeSetTheme(t);
        persist(SETTINGS_KEYS.theme, t);
      },
      setAccent: (a) => {
        storeSetAccent(a);
        persist(SETTINGS_KEYS.accent, a);
      },
      setDensity: (d) => {
        storeSetDensity(d);
        persist(SETTINGS_KEYS.density, d);
      },
      setShowPreview: (v) => {
        storeSetShowPreview(v);
        persist(SETTINGS_KEYS.showPreview, String(v));
      },
      setShowAvatars: (v) => {
        storeSetShowAvatars(v);
        persist(SETTINGS_KEYS.showAvatars, String(v));
      },
    }),
    [
      theme,
      accent,
      density,
      showPreview,
      showAvatars,
      storeSetTheme,
      storeSetAccent,
      storeSetDensity,
      storeSetShowPreview,
      storeSetShowAvatars,
    ]
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance must be used within AppearanceProvider");
  return ctx;
}
```

- [ ] **Step 4: Uruchom — pass**

Run: `npm test -- src/shared/appearance/AppearanceProvider.test.tsx`
Expected: PASS (3 testy).

- [ ] **Step 5: Zamontuj w main.tsx, usuń ThemeProvider**

Modify `src/main.tsx` — pełna nowa zawartość:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppearanceProvider } from "./shared/appearance/AppearanceProvider";
import { QueryProvider } from "./app/QueryProvider";
import "@fontsource-variable/plus-jakarta-sans";
import "./shared/theme/tokens.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryProvider>
      <AppearanceProvider>
        <App />
      </AppearanceProvider>
    </QueryProvider>
  </React.StrictMode>
);
```

(AppearanceProvider wewnątrz QueryProvider — `getSettings` to bezpośredni invoke, nie wymaga react-query, ale kolejność nie szkodzi.)

Delete `src/shared/theme/ThemeProvider.tsx`:

```bash
git rm src/shared/theme/ThemeProvider.tsx
```

- [ ] **Step 6: Napraw AppShell.test.tsx**

Modify `src/app/AppShell.test.tsx`:

Usuń blok (nieaktualny — AppShell nie importuje `useTheme`):

```tsx
vi.mock("../shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ mode: "light", setMode: vi.fn(), resolved: "light" }),
}));
```

W mocku `../app/store` dodaj do obiektu `state` pola wyglądu i Settings (po `density: "comfortable",`):

```tsx
      theme: "auto",
      accent: "#4f46e5",
      showPreview: true,
      showAvatars: true,
      settingsOpen: false,
```

oraz do setterów (po `setDensity: vi.fn(),`):

```tsx
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      setShowPreview: vi.fn(),
      setShowAvatars: vi.fn(),
      hydrateAppearance: vi.fn(),
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
```

- [ ] **Step 7: Uruchom pełny zestaw frontu**

Run: `npm test`
Expected: PASS (wszystkie, w tym AppShell.test, AppearanceProvider.test).

- [ ] **Step 8: Commit**

```bash
git add src/shared/appearance/AppearanceProvider.tsx src/shared/appearance/AppearanceProvider.test.tsx src/main.tsx src/app/AppShell.test.tsx
git rm src/shared/theme/ThemeProvider.tsx
git commit -m "feat(ui): AppearanceProvider loads/applies/persists appearance; replace ThemeProvider"
```

---

### Task 5: Szkielet Settings (overlay + nav + placeholdery + ⚙)

**Files:**
- Modify: `src/app/store.ts` (dodaj `settingsOpen` + `openSettings`/`closeSettings`)
- Create: `src/features/settings/SettingsOverlay.tsx`
- Create: `src/features/settings/Settings.css`
- Create: `src/features/settings/SettingsOverlay.test.tsx`
- Modify: `src/features/mailbox/MailboxRail.tsx` (przycisk ⚙ w stopce)
- Modify: `src/app/AppShell.tsx` (render `SettingsOverlay` gdy `settingsOpen`)

**Interfaces:**
- Consumes: store `settingsOpen`/`openSettings`/`closeSettings`.
- Produces: `SettingsOverlay` component; sekcje nav identyfikowane stringiem `SettingsSection = "general"|"accounts"|"appearance"|"signatures"|"notifications"|"rules"|"snooze"|"shortcuts"`; placeholder render dla wszystkich poza `appearance` (Appearance wypełni Task 6 — tu render nagłówka sekcji + slot).

- [ ] **Step 1: Dodaj stan Settings do store**

Modify `src/app/store.ts` — dodaj do typu `UiState` (po `showAvatars: boolean;`):

```ts
  settingsOpen: boolean;
```

do setterów w typie (po `hydrateAppearance: ...;`):

```ts
  openSettings: () => void;
  closeSettings: () => void;
```

do wartości initial (po `showAvatars: DEFAULT_APPEARANCE.showAvatars,`):

```ts
  settingsOpen: false,
```

i do implementacji (po `hydrateAppearance: ...,`):

```ts
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
```

- [ ] **Step 2: Napisz failing test overlay**

Create `src/features/settings/SettingsOverlay.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

import { SettingsOverlay } from "./SettingsOverlay";
import { AppearanceProvider } from "../../shared/appearance/AppearanceProvider";
import { useUiStore } from "../../app/store";

function renderOverlay() {
  return render(
    <AppearanceProvider>
      <SettingsOverlay />
    </AppearanceProvider>
  );
}

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true });
});

describe("SettingsOverlay", () => {
  it("shows the eight nav sections with Appearance active by default", () => {
    renderOverlay();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "General" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shortcuts" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
  });

  it("switching to a non-appearance section shows a placeholder", () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
  });

  it("close button calls closeSettings", () => {
    const closeSettings = vi.fn();
    useUiStore.setState({ closeSettings });
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(closeSettings).toHaveBeenCalled();
  });

  it("Escape key closes the overlay", () => {
    const closeSettings = vi.fn();
    useUiStore.setState({ closeSettings });
    renderOverlay();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeSettings).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Uruchom — fail**

Run: `npm test -- src/features/settings/SettingsOverlay.test.tsx`
Expected: FAIL ("Cannot find module './SettingsOverlay'").

- [ ] **Step 4: Zaimplementuj SettingsOverlay (z placeholderami; Appearance osadza AppearanceSection — w tym Tasku jako tymczasowy nagłówek, wypełni Task 6)**

Create `src/features/settings/SettingsOverlay.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useUiStore } from "../../app/store";
import { AppearanceSection } from "./AppearanceSection";
import "./Settings.css";

type SettingsSection =
  | "general"
  | "accounts"
  | "appearance"
  | "signatures"
  | "notifications"
  | "rules"
  | "snooze"
  | "shortcuts";

const NAV: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "appearance", label: "Appearance" },
  { id: "signatures", label: "Signatures" },
  { id: "notifications", label: "Notifications" },
  { id: "rules", label: "Rules & Filters" },
  { id: "snooze", label: "Snooze" },
  { id: "shortcuts", label: "Shortcuts" },
];

export function SettingsOverlay() {
  const closeSettings = useUiStore((s) => s.closeSettings);
  const [active, setActive] = useState<SettingsSection>("appearance");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeSettings]);

  const activeLabel = NAV.find((n) => n.id === active)?.label ?? "";

  return (
    <div className="settings-overlay" role="dialog" aria-label="Settings" aria-modal="true">
      <div className="settings-panel">
        <aside className="settings-nav">
          <div className="settings-nav__title">Settings</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`settings-nav__item${active === n.id ? " settings-nav__item--active" : ""}`}
              onClick={() => setActive(n.id)}
            >
              {n.label}
            </button>
          ))}
        </aside>
        <section className="settings-content">
          <header className="settings-content__header">
            <h2 className="settings-content__heading">{activeLabel}</h2>
            <button
              type="button"
              className="settings-content__close"
              aria-label="Close settings"
              onClick={closeSettings}
            >
              ✕
            </button>
          </header>
          {active === "appearance" ? (
            <AppearanceSection />
          ) : (
            <div className="settings-placeholder">Coming soon</div>
          )}
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Tymczasowy AppearanceSection (stub), żeby overlay się kompilował**

Create `src/features/settings/AppearanceSection.tsx` (stub — pełna implementacja w Task 6):

```tsx
export function AppearanceSection() {
  return <div className="appearance-section" />;
}
```

- [ ] **Step 6: Settings.css (port z szablonu — układ overlay + nav + content)**

Create `src/features/settings/Settings.css`:

```css
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}

.settings-panel {
  display: flex;
  width: min(880px, 92vw);
  height: min(640px, 88vh);
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
}

.settings-nav {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-subtle);
  padding: var(--space-3) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-nav__title {
  font-weight: 800;
  font-size: 15px;
  padding: var(--space-2) var(--space-3) var(--space-4);
}

.settings-nav__item {
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}

.settings-nav__item:hover {
  background: var(--bg-elevated);
}

.settings-nav__item--active {
  background: var(--bg-elevated);
  color: var(--accent);
  font-weight: 600;
}

.settings-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.settings-content__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-6) var(--space-6) var(--space-3);
}

.settings-content__heading {
  font-size: 22px;
  font-weight: 800;
  margin: 0;
  color: var(--text-primary);
}

.settings-content__close {
  background: transparent;
  border: none;
  font-size: 16px;
  cursor: pointer;
  color: var(--text-muted);
}

.settings-placeholder {
  padding: var(--space-6);
  color: var(--text-muted);
  font-size: 14px;
}
```

- [ ] **Step 7: ⚙ w stopce MailboxRail**

Modify `src/features/mailbox/MailboxRail.tsx`:

W `useUiStore` selektorach (po `const setSelectedSmartFolder = ...`):

```tsx
  const openSettings = useUiStore((s) => s.openSettings);
```

W stopce, zmień blok przycisku „Add account" tak, by obok niego był przycisk ⚙. Zamień istniejący `<div style={{ padding: "var(--space-3)" }}>...</div>` (ten z „Add account") na:

```tsx
      <div style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-3)" }}>
        <button
          onClick={() => setWizardOpen(true)}
          style={{
            flex: 1,
            background: "var(--accent)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-white)",
            cursor: "pointer",
            fontSize: "13px",
            padding: "var(--space-2) var(--space-3)",
          }}
        >
          Add account
        </button>
        <button
          onClick={openSettings}
          aria-label="Open settings"
          style={{
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-on-rail)",
            cursor: "pointer",
            fontSize: "14px",
            padding: "var(--space-2) var(--space-3)",
          }}
        >
          ⚙
        </button>
      </div>
```

- [ ] **Step 8: Render overlay w AppShell**

Modify `src/app/AppShell.tsx`:

Dodaj import:

```tsx
import { SettingsOverlay } from "../features/settings/SettingsOverlay";
```

Dodaj selektor w komponencie (po `const composerOpen = ...`):

```tsx
  const settingsOpen = useUiStore((s) => s.settingsOpen);
```

Zmień `data-density` na sterowane ze store — w sygnaturze komponentu dodaj selektor (po `settingsOpen`):

```tsx
  const density = useUiStore((s) => s.density);
```

i w JSX zmień `<div className="shell" data-density="comfortable">` na:

```tsx
    <div className="shell" data-density={density}>
```

Przed `{composerOpen && <Composer />}` dodaj:

```tsx
      {settingsOpen && <SettingsOverlay />}
```

- [ ] **Step 9: Uruchom testy overlay + AppShell + store**

Run: `npm test -- src/features/settings/SettingsOverlay.test.tsx src/app/AppShell.test.tsx src/app/store.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/app/store.ts src/features/settings/SettingsOverlay.tsx src/features/settings/AppearanceSection.tsx src/features/settings/Settings.css src/features/settings/SettingsOverlay.test.tsx src/features/mailbox/MailboxRail.tsx src/app/AppShell.tsx
git commit -m "feat(ui): settings overlay shell with sidebar nav + placeholders, gear entry"
```

---

### Task 6: Sekcja Appearance (Theme / Accent / Density / toggles)

**Files:**
- Modify: `src/features/settings/AppearanceSection.tsx` (pełna implementacja zamiast stuba)
- Modify: `src/features/settings/Settings.css` (style sekcji Appearance — radio-cards, swatch'e, toggle-switch)
- Create: `src/features/settings/AppearanceSection.test.tsx`

**Interfaces:**
- Consumes: `useAppearance()` (Task 4), `THEME_MODES`, `ACCENT_PRESETS`, `DENSITIES` (Task 3).
- Produces: `AppearanceSection` renderujący kontrolki i wołający settery z `useAppearance`.

- [ ] **Step 1: Napisz failing test sekcji**

Create `src/features/settings/AppearanceSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const setTheme = vi.fn();
const setAccent = vi.fn();
const setDensity = vi.fn();
const setShowPreview = vi.fn();
const setShowAvatars = vi.fn();

vi.mock("../../shared/appearance/AppearanceProvider", () => ({
  useAppearance: () => ({
    theme: "auto",
    accent: "#4f46e5",
    density: "comfortable",
    showPreview: true,
    showAvatars: true,
    setTheme,
    setAccent,
    setDensity,
    setShowPreview,
    setShowAvatars,
  }),
}));

import { AppearanceSection } from "./AppearanceSection";

beforeEach(() => {
  [setTheme, setAccent, setDensity, setShowPreview, setShowAvatars].forEach((f) => f.mockClear());
});

describe("AppearanceSection", () => {
  it("selecting Dark calls setTheme('dark')", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("selecting an accent swatch calls setAccent with its hex", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("button", { name: "Accent #10b981" }));
    expect(setAccent).toHaveBeenCalledWith("#10b981");
  });

  it("selecting Dense calls setDensity('dense')", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("button", { name: /Dense/ }));
    expect(setDensity).toHaveBeenCalledWith("dense");
  });

  it("toggling preview text calls setShowPreview(false)", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Show preview text" }));
    expect(setShowPreview).toHaveBeenCalledWith(false);
  });

  it("toggling avatars calls setShowAvatars(false)", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Show sender avatars" }));
    expect(setShowAvatars).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Uruchom — fail (stub nie ma kontrolek)**

Run: `npm test -- src/features/settings/AppearanceSection.test.tsx`
Expected: FAIL (brak przycisków/switchy).

- [ ] **Step 3: Zaimplementuj AppearanceSection**

Modify `src/features/settings/AppearanceSection.tsx` — pełna zawartość:

```tsx
import { useAppearance } from "../../shared/appearance/AppearanceProvider";
import { THEME_MODES, ACCENT_PRESETS, DENSITIES } from "../../shared/appearance/appearance";

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="appearance-toggle">
      <div className="appearance-toggle__text">
        <div className="appearance-toggle__label">{label}</div>
        {hint && <div className="appearance-toggle__hint">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch${checked ? " switch--on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}

export function AppearanceSection() {
  const a = useAppearance();

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">
        Personalize how AbeonMail looks on this device.
      </p>

      <div className="appearance-field__label">Theme</div>
      <div className="theme-cards">
        {THEME_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`theme-card${a.theme === m.value ? " theme-card--active" : ""}`}
            onClick={() => a.setTheme(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="appearance-field__label">Accent color</div>
      <div className="accent-swatches">
        {ACCENT_PRESETS.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={`Accent ${hex}`}
            aria-pressed={a.accent === hex}
            className={`accent-swatch${a.accent === hex ? " accent-swatch--active" : ""}`}
            style={{ background: hex }}
            onClick={() => a.setAccent(hex)}
          >
            {a.accent === hex && <span className="accent-swatch__check">✓</span>}
          </button>
        ))}
      </div>

      <div className="appearance-field__label">Message density</div>
      <div className="density-cards">
        {DENSITIES.map((d) => (
          <button
            key={d.value}
            type="button"
            className={`density-card${a.density === d.value ? " density-card--active" : ""}`}
            onClick={() => a.setDensity(d.value)}
          >
            <span className="density-card__label">{d.label}</span>
            <span className="density-card__hint">{d.hint}</span>
          </button>
        ))}
      </div>

      <div className="appearance-field__label">Message list</div>
      <Toggle
        label="Show preview text"
        hint="Display the first line of each message"
        checked={a.showPreview}
        onChange={a.setShowPreview}
      />
      <Toggle
        label="Show sender avatars"
        checked={a.showAvatars}
        onChange={a.setShowAvatars}
      />
    </div>
  );
}
```

- [ ] **Step 4: Style sekcji Appearance (port z szablonu)**

Modify `src/features/settings/Settings.css` — dopisz na końcu:

```css
.appearance-section {
  padding: 0 var(--space-6) var(--space-6);
}

.appearance-section__intro {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0 0 var(--space-6);
}

.appearance-field__label {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: var(--space-3);
}

.theme-cards,
.density-cards {
  display: flex;
  gap: var(--space-3);
  margin-bottom: var(--space-6);
}

.theme-card,
.density-card {
  flex: 1;
  background: var(--bg-elevated);
  border: 2px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  font-size: 14px;
  color: var(--text-primary);
  text-align: left;
}

.density-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.density-card__hint {
  font-size: 12px;
  color: var(--text-muted);
}

.theme-card--active,
.density-card--active {
  border-color: var(--accent);
  color: var(--accent);
}

.accent-swatches {
  display: flex;
  gap: 14px;
  margin-bottom: var(--space-6);
}

.accent-swatch {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.accent-swatch--active {
  box-shadow: 0 0 0 3px var(--bg-surface), 0 0 0 5px var(--accent);
}

.appearance-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border-subtle);
}

.appearance-toggle__label {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.appearance-toggle__hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 1px;
}

.switch {
  width: 42px;
  height: 24px;
  border-radius: 999px;
  border: none;
  background: var(--border-subtle);
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
}

.switch--on {
  background: var(--accent);
}

.switch__knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s ease;
}

.switch--on .switch__knob {
  left: 21px;
}
```

- [ ] **Step 5: Uruchom test sekcji + overlay**

Run: `npm test -- src/features/settings/AppearanceSection.test.tsx src/features/settings/SettingsOverlay.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/AppearanceSection.tsx src/features/settings/AppearanceSection.test.tsx src/features/settings/Settings.css
git commit -m "feat(ui): functional Appearance settings (theme, accent, density, toggles)"
```

---

### Task 7: Avatary + preview-text w liście wiadomości

**Files:**
- Create: `src/shared/appearance/Avatar.tsx`
- Create: `src/shared/appearance/Avatar.test.tsx`
- Modify: `src/features/message-list/MessageListPane.tsx` (render avatara + warunkowy snippet wg store; dense ukrywa snippet)
- Modify: `src/features/message-list/MessageListPane.css` (styl avatara)

**Interfaces:**
- Consumes: `initials`, `avatarColor` (Task 3); store `showPreview`, `showAvatars`, `density`.
- Produces: `Avatar({ seed, label, size? })` component.

- [ ] **Step 1: Napisz failing test Avatara**

Create `src/shared/appearance/Avatar.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar } from "./Avatar";
import { avatarColor } from "./appearance";

describe("Avatar", () => {
  it("renders initials from the label", () => {
    render(<Avatar seed="malak@x.com" label="Malak Frederick" />);
    expect(screen.getByText("MF")).toBeTruthy();
  });

  it("uses the deterministic color for the seed", () => {
    render(<Avatar seed="a@b.com" label="Alice Brown" />);
    const el = screen.getByText("AB");
    expect(el.style.background).toBeTruthy();
    expect(el.getAttribute("data-color")).toBe(avatarColor("a@b.com"));
  });
});
```

- [ ] **Step 2: Uruchom — fail**

Run: `npm test -- src/shared/appearance/Avatar.test.tsx`
Expected: FAIL ("Cannot find module './Avatar'").

- [ ] **Step 3: Zaimplementuj Avatar**

Create `src/shared/appearance/Avatar.tsx`:

```tsx
import { initials, avatarColor } from "./appearance";

export function Avatar({
  seed,
  label,
  size = 28,
}: {
  seed: string;
  label: string;
  size?: number;
}) {
  const color = avatarColor(seed);
  return (
    <span
      className="avatar"
      data-color={color}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.4,
        fontWeight: 600,
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {initials(label)}
    </span>
  );
}
```

- [ ] **Step 4: Uruchom — pass**

Run: `npm test -- src/shared/appearance/Avatar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wepnij avatary + preview do MessageListPane**

Modify `src/features/message-list/MessageListPane.tsx`:

Dodaj importy (po istniejących):

```tsx
import { Avatar } from "../../shared/appearance/Avatar";
```

`ThreadRow` i `SmartRow` dostają nowe propsy `showAvatars` i `showSnippet`. Zmień sygnatury i render.

Dla `ThreadRow` — zmień destrukturyzację propsów na:

```tsx
function ThreadRow({
  thread,
  isSelected,
  rowHeight,
  showAvatars,
  showSnippet,
  onSelect,
}: {
  thread: ThreadSummary;
  isSelected: boolean;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  onSelect: (id: number) => void;
}) {
```

W `ThreadRow`, zaraz po `<div className="message-row__indicators">...</div>` (przed `<div className="message-row__content">`) wstaw avatar:

```tsx
      {showAvatars && (
        <Avatar
          seed={thread.participants[0] ?? thread.subject}
          label={thread.participants[0] ?? "?"}
        />
      )}
```

oraz zamień linię snippetu `<span className="message-row__snippet">{thread.snippet}</span>` na:

```tsx
        {showSnippet && <span className="message-row__snippet">{thread.snippet}</span>}
```

Dla `SmartRow` — analogicznie zmień sygnaturę:

```tsx
function SmartRow({
  row,
  isSelected,
  rowHeight,
  showAvatars,
  showSnippet,
  onSelect,
}: {
  row: SmartMessageRow;
  isSelected: boolean;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  onSelect: (id: number) => void;
}) {
```

Po `<div className="message-row__indicators">...</div>` w `SmartRow` wstaw:

```tsx
      {showAvatars && <Avatar seed={row.from_address} label={row.from_name ?? row.from_address} />}
```

i zamień `<span className="message-row__snippet">{row.snippet}</span>` na:

```tsx
        {showSnippet && <span className="message-row__snippet">{row.snippet}</span>}
```

W `MessageListPane` (główny komponent) dodaj selektory store (po `const density = ...`):

```tsx
  const showPreview = useUiStore((s) => s.showPreview);
  const showAvatars = useUiStore((s) => s.showAvatars);
```

i oblicz `showSnippet` (po `const rowHeight = ...`):

```tsx
  const showSnippet = showPreview && density !== "dense";
```

Następnie przekaż propsy w obu miejscach renderowania wierszy. Zmień wywołanie `<SmartRow ... />` na:

```tsx
                    <SmartRow
                      row={row}
                      isSelected={selectedMessageId === row.message_id}
                      rowHeight={rowHeight}
                      showAvatars={showAvatars}
                      showSnippet={showSnippet}
                      onSelect={setSelectedMessageId}
                    />
```

i `<ThreadRow ... />` na:

```tsx
                  <ThreadRow
                    thread={thread}
                    isSelected={selectedThreadId === thread.thread_id}
                    rowHeight={rowHeight}
                    showAvatars={showAvatars}
                    showSnippet={showSnippet}
                    onSelect={setSelectedThreadId}
                  />
```

- [ ] **Step 6: Styl avatara w wierszu (odstęp)**

Modify `src/features/message-list/MessageListPane.css` — dopisz na końcu:

```css
.message-row .avatar {
  margin-right: var(--space-2);
  align-self: center;
}
```

- [ ] **Step 7: Uruchom pełny zestaw frontu**

Run: `npm test`
Expected: PASS (w tym Avatar.test, AppShell.test — `showAvatars`/`showPreview` w mocku store z Task 4/5 już są).

- [ ] **Step 8: Commit**

```bash
git add src/shared/appearance/Avatar.tsx src/shared/appearance/Avatar.test.tsx src/features/message-list/MessageListPane.tsx src/features/message-list/MessageListPane.css
git commit -m "feat(ui): sender avatars and preview-text toggle in message list"
```

---

### Task 8: Tokeny akcentu, density CSS, weryfikacja end-to-end

**Files:**
- Modify: `src/shared/theme/tokens.css` (dodaj brakujące presety akcentu jako tokeny; drobne korekty density)
- Modify: `src/features/message-list/MessageListPane.css` (korekty paddingu wg `data-density`)

**Interfaces:** brak nowych — krok integracyjny i weryfikacyjny.

- [ ] **Step 1: Uzupełnij tokeny akcentu**

Modify `src/shared/theme/tokens.css` — w bloku `:root { ... }` po `--accent-pink: #ec4899;` dodaj brakujące presety (dla spójności palety; runtime i tak nadpisuje `--accent` inline):

```css
  --accent-violet: #7c3aed;
  --accent-emerald: #10b981;
  --accent-orange: #ef5d3a;
```

- [ ] **Step 2: Korekty density (CSS)**

Modify `src/features/message-list/MessageListPane.css` — dopisz na końcu:

```css
.shell[data-density="compact"] .message-row {
  padding-top: 0;
  padding-bottom: 0;
}

.shell[data-density="dense"] .message-row {
  padding-top: 0;
  padding-bottom: 0;
}

.shell[data-density="dense"] .message-row__meta {
  margin-top: 0;
}
```

- [ ] **Step 3: Pełny zestaw testów backend + frontend**

Run: `cargo test --workspace`
Expected: PASS (wraz z testami `settings_repo`).

Run: `npm test`
Expected: PASS (wszystkie).

- [ ] **Step 4: Czysty build**

Run: `cargo build -p abeonmail`
Expected: bez błędów.

Run: `npm run build`
Expected: `tsc` bez błędów typów + vite build OK.

- [ ] **Step 5: Fidelity check (uruchomienie aplikacji)**

Uruchom aplikację: `npm run tauri dev` (Node 24 w PATH, `DISPLAY=:1`).
W aplikacji:
1. Kliknij ⚙ w stopce railu → otwiera się overlay Settings z aktywną sekcją Appearance.
2. Porównaj z `docs/templates/AbeonMail Screens.html` (ekran Settings → Appearance): układ sidebara (8 sekcji), nagłówek „Appearance" + podtytuł, radio-cards Theme, 6 swatchy accent (zaznaczony z checkiem), 3 karty density z podtytułami, toggle-switche 42×24 z białą gałką.
3. Zmień Theme na Dark → cała aplikacja przechodzi w tryb ciemny natychmiast.
4. Zmień accent na inny preset → kolor akcentu (przyciski, zaznaczenia) zmienia się natychmiast.
5. Zmień density na Dense → wiersze listy gęstnieją, snippet znika.
6. Wyłącz „Show preview text" → snippet znika niezależnie od density.
7. Wyłącz „Show sender avatars" → avatary znikają.
8. Zamknij i otwórz ponownie aplikację → wszystkie ustawienia zachowane (persystencja z SQLite).

Kryterium: zachowanie i wygląd zgodne z szablonem i punktami 1–8.

- [ ] **Step 6: Commit**

```bash
git add src/shared/theme/tokens.css src/features/message-list/MessageListPane.css
git commit -m "feat(ui): accent preset tokens and density-aware list spacing"
```

---

## Self-Review

**Spec coverage:**
- Szkielet Settings (overlay + 8 sekcji + placeholdery) → Task 5. ✓
- Theme (light/dark/auto, persyst.) → Task 4 (apply/persist) + Task 6 (UI). ✓
- Accent (6 presetów, `--accent`) → Task 6 (UI) + Task 4 (apply) + Task 8 (tokeny). ✓
- Density (3 poziomy, `data-density`, metryki listy) → Task 3 (typ+ROW_HEIGHT) + Task 5 (data-density ze store) + Task 6 (UI) + Task 8 (CSS). ✓
- Show preview text → Task 6 (UI) + Task 7 (efekt w liście). ✓
- Show sender avatars (inicjały) → Task 6 (UI) + Task 7 (Avatar + render). ✓
- Persystencja SQLite (V6, settings_repo, komendy) → Task 1 + Task 2. ✓
- AppearanceProvider load/apply/persist, reconcile bez flashu → Task 4. ✓
- Wejście ⚙ w railu → Task 5. ✓
- Fidelity check vs szablon → Task 8. ✓
- Poza zakresem (thread toggle, dock badge) — nie ma zadań, zgodnie ze specem. ✓

**Placeholder scan:** Brak „TBD/TODO" w krokach; każdy krok kodu zawiera pełny kod. AppearanceSection stub w Task 5 jest świadomy i jawnie zastąpiony w Task 6 (kompiluje overlay wcześniej).

**Type consistency:** `Density` = `comfortable|compact|dense` spójnie (Task 3 definiuje, store reeksportuje, ROW_HEIGHT/DENSITIES używają). `SETTINGS_KEYS` użyte spójnie w `parseSettings` i `AppearanceProvider`. Komendy `getSettings`/`setSetting` zwracają `Result<...>` (tauri-specta) — w testach mockowane jako `{status,data}`; produkcyjny `AppearanceProvider` sprawdza `res.status === "ok"`. `useAppearance` settery zgodne między providerem (Task 4) a użyciem w sekcji (Task 6).

## Execution Handoff

Patrz wiadomość po zapisaniu planu.
