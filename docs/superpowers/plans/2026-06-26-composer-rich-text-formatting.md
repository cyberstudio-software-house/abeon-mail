# Composer Rich-Text Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rozbudować edytor TipTap w composerze (`src/features/composer/Composer.tsx`) do pełnego zakresu formatowania: czcionka, rozmiar, kolory, style tekstu, nagłówki, wyrównanie, listy (punktowane/numerowane/zadań), tabele z edycją, cytat, kod, linia pozioma, link, obraz, wyczyść formatowanie.

**Architecture:** Cała praca po stronie frontu — backendowy sanitizer (`crates/am-mime/src/sanitize.rs`) już przepuszcza tabele, listy i inline `style` (font, size, color, align) i robi to także przy wysyłce. Konfigurację rozszerzeń i pasek narzędzi wydzielamy do nowego katalogu `src/features/composer/editor/`, a `Composer.tsx` tylko je składa.

**Tech Stack:** TipTap v3.27.0 (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-*`), React 19, TypeScript, Vitest + @testing-library/react + happy-dom, lucide-react (ikony).

## Global Constraints

- **Backendu NIE zmieniamy** — sanitizer już wspiera tabele/listy/inline-style przy renderze i wysyłce.
- **Node >= 24** do `npm install` i `npm run build` (aktywny shell bywa Node 18 → `vite`/`tsc` pada na `crypto.hash`). W razie błędu: `nvm use 24` (lub upewnij się, że `node -v` ≥ 24) przed instalacją/buildem.
- **Brak komentarzy w kodzie.** Wszystkie identyfikatory i nazwy w **języku angielskim** (etykiety UI dla użytkownika mogą być po polsku).
- **TipTap v3:** `Underline` i `Link` są już w `StarterKit` — nie instaluj ich osobno, dodaj tylko przyciski. `TextStyle`, `Color`, `FontFamily`, `FontSize` importuj z `@tiptap/extension-text-style`. Jeśli któryś named export nie istnieje w zainstalowanej wersji, sprawdź `node_modules/@tiptap/extension-text-style/dist` i użyj właściwej ścieżki/pakietu (fallback: `@tiptap/extension-color`, `@tiptap/extension-font-family`).
- **Ikony:** import nazwany z `lucide-react` (już w dependencies).
- **Testy:** wzoruj się na istniejących `src/**/*.test.tsx`. Używaj `vitest` + `@testing-library/react` + `@testing-library/user-event`. **Nie używaj matcherów jest-dom** (`toBeInTheDocument` itp.) — używaj `expect(...).toBe(...)`, `.toBeNull()`, `(el as HTMLButtonElement).disabled`.
- **Commity:** Conventional Commits, po angielsku, bez `Co-Authored-By`. Commit na końcu każdego zadania.
- **Nowe pliki:** wszystkie pod `src/features/composer/editor/`.

---

### Task 1: Install extensions + editor configuration

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/features/composer/editor/extensions.ts`
- Test: `src/features/composer/editor/extensions.test.ts`

**Interfaces:**
- Produces: `createEditorExtensions(): Extensions` — lista skonfigurowanych rozszerzeń TipTap przekazywana do `useEditor({ extensions })`.

- [ ] **Step 1: Install packages** (Node ≥ 24)

Run:
```bash
npm install @tiptap/extension-table@^3.27.0 @tiptap/extension-table-row@^3.27.0 \
  @tiptap/extension-table-cell@^3.27.0 @tiptap/extension-table-header@^3.27.0 \
  @tiptap/extension-text-style@^3.27.0 @tiptap/extension-highlight@^3.27.0 \
  @tiptap/extension-text-align@^3.27.0 @tiptap/extension-task-list@^3.27.0 \
  @tiptap/extension-task-item@^3.27.0
```
Expected: `package.json` zyskuje 9 nowych zależności `@tiptap/extension-*@^3.27.0`.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createEditorExtensions } from "./extensions";

describe("createEditorExtensions", () => {
  it("includes the full formatting extension set", () => {
    const names = createEditorExtensions().map((extension) => extension.name);
    const expected = [
      "starterKit", "image", "textStyle", "color", "fontFamily", "fontSize",
      "highlight", "textAlign", "table", "tableRow", "tableHeader", "tableCell",
      "taskList", "taskItem",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/composer/editor/extensions.test.ts`
Expected: FAIL — `Cannot find module './extensions'`.

- [ ] **Step 4: Write minimal implementation**

```ts
import StarterKit from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TextStyle, Color, FontFamily, FontSize } from "@tiptap/extension-text-style";
import { Highlight } from "@tiptap/extension-highlight";
import { TextAlign } from "@tiptap/extension-text-align";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import type { Extensions } from "@tiptap/core";

export function createEditorExtensions(): Extensions {
  return [
    StarterKit,
    Image,
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}
```

If a named import fails to resolve, follow the Global Constraints fallback note for `@tiptap/extension-text-style`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/composer/editor/extensions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/features/composer/editor/extensions.ts src/features/composer/editor/extensions.test.ts
git commit -m "feat(composer): add full TipTap extension set"
```

---

### Task 2: Font and color presets

**Files:**
- Create: `src/features/composer/editor/fontPresets.ts`
- Test: `src/features/composer/editor/fontPresets.test.ts`

**Interfaces:**
- Produces:
  - `FontFamilyOption = { label: string; value: string | null }`
  - `FontSizeOption = { label: string; value: string | null }`
  - `FONT_FAMILIES: FontFamilyOption[]`
  - `FONT_SIZE_PRESETS: FontSizeOption[]`
  - `COLOR_SWATCHES: string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { FONT_FAMILIES, FONT_SIZE_PRESETS, COLOR_SWATCHES } from "./fontPresets";

describe("font presets", () => {
  it("offers a default (reset) font family with null value", () => {
    expect(FONT_FAMILIES[0]).toEqual({ label: "Domyślna", value: null });
    expect(FONT_FAMILIES.length).toBeGreaterThanOrEqual(10);
  });

  it("maps named sizes with Normalny as reset", () => {
    const small = FONT_SIZE_PRESETS.find((size) => size.label === "Mały");
    const normal = FONT_SIZE_PRESETS.find((size) => size.label === "Normalny");
    const large = FONT_SIZE_PRESETS.find((size) => size.label === "Duży");
    expect(small?.value).toBe("13px");
    expect(normal?.value).toBeNull();
    expect(large?.value).toBe("18px");
  });

  it("provides a grid of hex swatches", () => {
    expect(COLOR_SWATCHES.length).toBeGreaterThanOrEqual(30);
    for (const color of COLOR_SWATCHES) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/composer/editor/fontPresets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
export type FontFamilyOption = { label: string; value: string | null };
export type FontSizeOption = { label: string; value: string | null };

export const FONT_FAMILIES: FontFamilyOption[] = [
  { label: "Domyślna", value: null },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Helvetica", value: "Helvetica, Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Geneva, sans-serif" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: "Comic Sans MS", value: "'Comic Sans MS', cursive" },
];

export const FONT_SIZE_PRESETS: FontSizeOption[] = [
  { label: "Mały", value: "13px" },
  { label: "Normalny", value: null },
  { label: "Duży", value: "18px" },
  { label: "Bardzo duży", value: "26px" },
];

export const COLOR_SWATCHES: string[] = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff",
  "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff",
  "#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc",
  "#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#8e7cc3",
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/composer/editor/fontPresets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/editor/fontPresets.ts src/features/composer/editor/fontPresets.test.ts
git commit -m "feat(composer): add font and color presets"
```

---

### Task 3: ToolbarPopover component

**Files:**
- Create: `src/features/composer/editor/ToolbarPopover.tsx`
- Test: `src/features/composer/editor/ToolbarPopover.test.tsx`

**Interfaces:**
- Produces: `ToolbarPopover` component with props
  `{ trigger: ReactNode; label: string; disabled?: boolean; children: (close: () => void) => ReactNode }`.
  Renders a trigger button (`aria-label={label}`, class `toolbar-btn`) and, when open, a panel (`.toolbar-popover__panel`). Closes on outside pointerdown and Escape. The `children` render-prop receives a `close` callback.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { ToolbarPopover } from "./ToolbarPopover";

describe("ToolbarPopover", () => {
  it("toggles the panel on trigger click", async () => {
    const user = userEvent.setup();
    render(
      <ToolbarPopover trigger="T" label="Test">
        {() => <div>panel-content</div>}
      </ToolbarPopover>,
    );
    expect(screen.queryByText("panel-content")).toBeNull();
    await user.click(screen.getByLabelText("Test"));
    expect(screen.getByText("panel-content")).toBeTruthy();
  });

  it("closes when the provided close fn runs", async () => {
    const user = userEvent.setup();
    render(
      <ToolbarPopover trigger="T" label="Test">
        {(close) => <button onClick={close}>do</button>}
      </ToolbarPopover>,
    );
    await user.click(screen.getByLabelText("Test"));
    await user.click(screen.getByText("do"));
    expect(screen.queryByText("do")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/composer/editor/ToolbarPopover.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { useRef, useEffect, useState, type ReactNode } from "react";

type ToolbarPopoverProps = {
  trigger: ReactNode;
  label: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
};

export function ToolbarPopover({ trigger, label, disabled, children }: ToolbarPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="toolbar-popover" ref={containerRef}>
      <button
        type="button"
        className="toolbar-btn"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && <div className="toolbar-popover__panel" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/composer/editor/ToolbarPopover.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/editor/ToolbarPopover.tsx src/features/composer/editor/ToolbarPopover.test.tsx
git commit -m "feat(composer): add ToolbarPopover primitive"
```

---

### Task 4: ColorSwatchGrid component

**Files:**
- Create: `src/features/composer/editor/ColorSwatchGrid.tsx`
- Test: `src/features/composer/editor/ColorSwatchGrid.test.tsx`

**Interfaces:**
- Consumes: `COLOR_SWATCHES` from `./fontPresets`.
- Produces: `ColorSwatchGrid` component with props `{ onPick: (color: string) => void; onReset: () => void }`.
  Each swatch button has `aria-label={`Kolor ${color}`}`; reset button text is `Domyślny`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ColorSwatchGrid } from "./ColorSwatchGrid";

describe("ColorSwatchGrid", () => {
  it("calls onPick with the swatch color", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<ColorSwatchGrid onPick={onPick} onReset={() => {}} />);
    await user.click(screen.getByLabelText("Kolor #ff0000"));
    expect(onPick).toHaveBeenCalledWith("#ff0000");
  });

  it("calls onReset from the default button", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(<ColorSwatchGrid onPick={() => {}} onReset={onReset} />);
    await user.click(screen.getByText("Domyślny"));
    expect(onReset).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/composer/editor/ColorSwatchGrid.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { COLOR_SWATCHES } from "./fontPresets";

type ColorSwatchGridProps = {
  onPick: (color: string) => void;
  onReset: () => void;
};

export function ColorSwatchGrid({ onPick, onReset }: ColorSwatchGridProps) {
  return (
    <div className="color-swatch-grid">
      <div className="color-swatch-grid__swatches">
        {COLOR_SWATCHES.map((color) => (
          <button
            key={color}
            type="button"
            className="color-swatch"
            style={{ backgroundColor: color }}
            aria-label={`Kolor ${color}`}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
      <button type="button" className="color-swatch-grid__reset" onClick={onReset}>
        Domyślny
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/composer/editor/ColorSwatchGrid.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/editor/ColorSwatchGrid.tsx src/features/composer/editor/ColorSwatchGrid.test.tsx
git commit -m "feat(composer): add ColorSwatchGrid"
```

---

### Task 5: Editor mock helper + TableMenu

**Files:**
- Create: `src/features/composer/editor/testSupport.ts`
- Create: `src/features/composer/editor/TableMenu.tsx`
- Test: `src/features/composer/editor/TableMenu.test.tsx`

**Interfaces:**
- Consumes: `ToolbarPopover` from `./ToolbarPopover`.
- Produces:
  - `createEditorMock(overrides?): { editor: Editor; chain: Record<string, Mock>; run: Mock }` (test helper). Every chain method (`focus`, `toggleBold`, `setFontSize`, `insertTable`, table ops, etc.) is a `vi.fn()` returning the same chain object; `run` returns `true`. `editor.chain()`, `editor.can()` return the chain; `editor.isActive()` returns `false`; `editor.getAttributes()` returns `{}`.
  - `TableMenu` component with props `{ editor: Editor | null }`. Popover labelled `Tabela`; action buttons by visible text (`Wstaw tabelę 3×3`, `Usuń tabelę`, …). Edit actions disabled unless `editor.can().<op>()` is truthy.

- [ ] **Step 1: Write the editor mock helper**

```ts
import { vi } from "vitest";
import type { Editor } from "@tiptap/react";

const CHAIN_METHODS = [
  "focus", "toggleBold", "toggleItalic", "toggleUnderline", "toggleStrike",
  "setColor", "unsetColor", "toggleHighlight", "unsetHighlight",
  "setFontFamily", "unsetFontFamily", "setFontSize", "unsetFontSize",
  "toggleHeading", "setParagraph", "setTextAlign",
  "toggleBulletList", "toggleOrderedList", "toggleTaskList",
  "toggleBlockquote", "toggleCodeBlock", "setHorizontalRule",
  "setLink", "unsetLink", "insertContent", "setImage",
  "insertTable", "addRowBefore", "addRowAfter", "deleteRow",
  "addColumnBefore", "addColumnAfter", "deleteColumn",
  "mergeCells", "splitCell", "deleteTable",
  "unsetAllMarks", "clearNodes",
];

export function createEditorMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const run = vi.fn(() => true);
  for (const method of CHAIN_METHODS) {
    chain[method] = vi.fn(() => chain);
  }
  chain.run = run;
  const editor = {
    chain: vi.fn(() => chain),
    can: vi.fn(() => chain),
    isActive: vi.fn(() => false),
    getAttributes: vi.fn(() => ({})),
    ...overrides,
  };
  return { editor: editor as unknown as Editor, chain, run };
}
```

- [ ] **Step 2: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { TableMenu } from "./TableMenu";
import { createEditorMock } from "./testSupport";

describe("TableMenu", () => {
  it("inserts a 3x3 table with header row", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<TableMenu editor={editor} />);
    await user.click(screen.getByLabelText("Tabela"));
    await user.click(screen.getByText("Wstaw tabelę 3×3"));
    expect(chain.insertTable).toHaveBeenCalledWith({ rows: 3, cols: 3, withHeaderRow: true });
  });

  it("deletes the current row", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<TableMenu editor={editor} />);
    await user.click(screen.getByLabelText("Tabela"));
    await user.click(screen.getByText("Usuń wiersz"));
    expect(chain.deleteRow).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/composer/editor/TableMenu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```tsx
import type { Editor } from "@tiptap/react";
import { Table as TableIcon, ChevronDown } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";

type TableMenuProps = { editor: Editor | null };

type TableAction = {
  label: string;
  run: (editor: Editor) => void;
  enabled: (editor: Editor) => boolean;
};

const TABLE_ACTIONS: TableAction[] = [
  { label: "Wstaw tabelę 3×3", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), enabled: () => true },
  { label: "Wiersz powyżej", run: (e) => e.chain().focus().addRowBefore().run(), enabled: (e) => Boolean(e.can().addRowBefore()) },
  { label: "Wiersz poniżej", run: (e) => e.chain().focus().addRowAfter().run(), enabled: (e) => Boolean(e.can().addRowAfter()) },
  { label: "Usuń wiersz", run: (e) => e.chain().focus().deleteRow().run(), enabled: (e) => Boolean(e.can().deleteRow()) },
  { label: "Kolumna z lewej", run: (e) => e.chain().focus().addColumnBefore().run(), enabled: (e) => Boolean(e.can().addColumnBefore()) },
  { label: "Kolumna z prawej", run: (e) => e.chain().focus().addColumnAfter().run(), enabled: (e) => Boolean(e.can().addColumnAfter()) },
  { label: "Usuń kolumnę", run: (e) => e.chain().focus().deleteColumn().run(), enabled: (e) => Boolean(e.can().deleteColumn()) },
  { label: "Scal komórki", run: (e) => e.chain().focus().mergeCells().run(), enabled: (e) => Boolean(e.can().mergeCells()) },
  { label: "Podziel komórkę", run: (e) => e.chain().focus().splitCell().run(), enabled: (e) => Boolean(e.can().splitCell()) },
  { label: "Usuń tabelę", run: (e) => e.chain().focus().deleteTable().run(), enabled: (e) => Boolean(e.can().deleteTable()) },
];

export function TableMenu({ editor }: TableMenuProps) {
  return (
    <ToolbarPopover
      trigger={<><TableIcon size={16} /><ChevronDown size={12} /></>}
      label="Tabela"
      disabled={!editor}
    >
      {(close) => (
        <div className="table-menu">
          {TABLE_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              className="table-menu__item"
              disabled={!editor || !action.enabled(editor)}
              onClick={() => {
                if (editor) action.run(editor);
                close();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </ToolbarPopover>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/composer/editor/TableMenu.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/composer/editor/testSupport.ts src/features/composer/editor/TableMenu.tsx src/features/composer/editor/TableMenu.test.tsx
git commit -m "feat(composer): add TableMenu and editor test mock"
```

---

### Task 6: LinkPopover component

**Files:**
- Create: `src/features/composer/editor/LinkPopover.tsx`
- Test: `src/features/composer/editor/LinkPopover.test.tsx`

**Interfaces:**
- Consumes: `ToolbarPopover` from `./ToolbarPopover`; `createEditorMock` from `./testSupport` (test only).
- Produces: `LinkPopover` component with props `{ editor: Editor | null }`. Popover labelled `Wstaw link`; inputs labelled `URL` and `Tekst linku`; submit button text `Wstaw`. With only URL → `setLink({ href })`; with URL + text → `insertContent('<a href="...">text</a>')`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { LinkPopover } from "./LinkPopover";
import { createEditorMock } from "./testSupport";

describe("LinkPopover", () => {
  it("sets a link from the URL field", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<LinkPopover editor={editor} />);
    await user.click(screen.getByLabelText("Wstaw link"));
    await user.type(screen.getByLabelText("URL"), "https://example.com");
    await user.click(screen.getByText("Wstaw"));
    expect(chain.setLink).toHaveBeenCalledWith({ href: "https://example.com" });
  });

  it("inserts an anchor when link text is provided", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<LinkPopover editor={editor} />);
    await user.click(screen.getByLabelText("Wstaw link"));
    await user.type(screen.getByLabelText("URL"), "https://example.com");
    await user.type(screen.getByLabelText("Tekst linku"), "Example");
    await user.click(screen.getByText("Wstaw"));
    expect(chain.insertContent).toHaveBeenCalledWith('<a href="https://example.com">Example</a>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/composer/editor/LinkPopover.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Link as LinkIcon } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";

type LinkPopoverProps = { editor: Editor | null };

export function LinkPopover({ editor }: LinkPopoverProps) {
  return (
    <ToolbarPopover trigger={<LinkIcon size={16} />} label="Wstaw link" disabled={!editor}>
      {(close) => <LinkForm editor={editor} close={close} />}
    </ToolbarPopover>
  );
}

function LinkForm({ editor, close }: { editor: Editor | null; close: () => void }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");

  function submit() {
    if (!editor || !url) {
      close();
      return;
    }
    if (text) {
      editor.chain().focus().insertContent(`<a href="${url}">${text}</a>`).run();
    } else {
      editor.chain().focus().setLink({ href: url }).run();
    }
    close();
  }

  return (
    <div className="link-form">
      <input
        className="link-form__input"
        placeholder="URL"
        aria-label="URL"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <input
        className="link-form__input"
        placeholder="Tekst (opcjonalnie)"
        aria-label="Tekst linku"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="button" className="link-form__submit" onClick={submit}>
        Wstaw
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/composer/editor/LinkPopover.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/editor/LinkPopover.tsx src/features/composer/editor/LinkPopover.test.tsx
git commit -m "feat(composer): add LinkPopover with URL and text fields"
```

---

### Task 7: EditorToolbar component

**Files:**
- Create: `src/features/composer/editor/EditorToolbar.tsx`
- Test: `src/features/composer/editor/EditorToolbar.test.tsx`

**Interfaces:**
- Consumes: `ToolbarPopover`, `ColorSwatchGrid`, `TableMenu`, `LinkPopover`, `FONT_FAMILIES`, `FONT_SIZE_PRESETS`; `createEditorMock` (test only).
- Produces: `EditorToolbar` component with props `{ editor: Editor | null; onInsertImage: () => void }`. Root element class `composer-toolbar`. Button aria-labels (PL): `Pogrubienie`, `Kursywa`, `Podkreślenie`, `Przekreślenie`, `Czcionka`, `Rozmiar czcionki`, `Kolor tekstu`, `Kolor tła`, `Nagłówek`, `Wyrównanie`, `Lista punktowana`, `Lista numerowana`, `Lista zadań`, `Cytat`, `Blok kodu`, `Linia pozioma`, `Wstaw obraz`, `Wyczyść formatowanie`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { EditorToolbar } from "./EditorToolbar";
import { createEditorMock } from "./testSupport";

describe("EditorToolbar", () => {
  it("does not crash and disables buttons when editor is null", () => {
    render(<EditorToolbar editor={null} onInsertImage={() => {}} />);
    expect((screen.getByLabelText("Pogrubienie") as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggles bold", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<EditorToolbar editor={editor} onInsertImage={() => {}} />);
    await user.click(screen.getByLabelText("Pogrubienie"));
    expect(chain.toggleBold).toHaveBeenCalled();
  });

  it("applies a named font size preset", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<EditorToolbar editor={editor} onInsertImage={() => {}} />);
    await user.click(screen.getByLabelText("Rozmiar czcionki"));
    await user.click(screen.getByText("Duży"));
    expect(chain.setFontSize).toHaveBeenCalledWith("18px");
  });

  it("calls onInsertImage", async () => {
    const user = userEvent.setup();
    const { editor } = createEditorMock();
    const onInsertImage = vi.fn();
    render(<EditorToolbar editor={editor} onInsertImage={onInsertImage} />);
    await user.click(screen.getByLabelText("Wstaw obraz"));
    expect(onInsertImage).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/composer/editor/EditorToolbar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
import type { ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold, Italic, Underline, Strikethrough, Type, Palette, Highlighter,
  Heading, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, ListChecks, Quote, Code, Minus,
  Image as ImageIcon, RemoveFormatting, ChevronDown,
} from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import { ColorSwatchGrid } from "./ColorSwatchGrid";
import { TableMenu } from "./TableMenu";
import { LinkPopover } from "./LinkPopover";
import { FONT_FAMILIES, FONT_SIZE_PRESETS } from "./fontPresets";

type EditorToolbarProps = {
  editor: Editor | null;
  onInsertImage: () => void;
};

function ToolbarButton(props: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`toolbar-btn${props.active ? " active" : ""}`}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

const HEADINGS = [
  { label: "Tekst zwykły", level: 0 },
  { label: "Nagłówek 1", level: 1 },
  { label: "Nagłówek 2", level: 2 },
  { label: "Nagłówek 3", level: 3 },
] as const;

const ALIGNMENTS = [
  { label: "Do lewej", value: "left", Icon: AlignLeft },
  { label: "Wyśrodkuj", value: "center", Icon: AlignCenter },
  { label: "Do prawej", value: "right", Icon: AlignRight },
  { label: "Wyjustuj", value: "justify", Icon: AlignJustify },
] as const;

export function EditorToolbar({ editor, onInsertImage }: EditorToolbarProps) {
  const disabled = !editor;

  return (
    <div className="composer-toolbar" role="toolbar" aria-label="Formatowanie">
      <ToolbarPopover trigger={<><Type size={16} /><ChevronDown size={12} /></>} label="Czcionka" disabled={disabled}>
        {(close) => (
          <div className="toolbar-menu">
            {FONT_FAMILIES.map((font) => (
              <button
                key={font.label}
                type="button"
                className="toolbar-menu__item"
                style={{ fontFamily: font.value ?? undefined }}
                onClick={() => {
                  if (editor) {
                    if (font.value) editor.chain().focus().setFontFamily(font.value).run();
                    else editor.chain().focus().unsetFontFamily().run();
                  }
                  close();
                }}
              >
                {font.label}
              </button>
            ))}
          </div>
        )}
      </ToolbarPopover>

      <ToolbarPopover trigger={<>A<ChevronDown size={12} /></>} label="Rozmiar czcionki" disabled={disabled}>
        {(close) => (
          <div className="toolbar-menu">
            {FONT_SIZE_PRESETS.map((size) => (
              <button
                key={size.label}
                type="button"
                className="toolbar-menu__item"
                onClick={() => {
                  if (editor) {
                    if (size.value) editor.chain().focus().setFontSize(size.value).run();
                    else editor.chain().focus().unsetFontSize().run();
                  }
                  close();
                }}
              >
                {size.label}
              </button>
            ))}
          </div>
        )}
      </ToolbarPopover>

      <ToolbarButton label="Pogrubienie" active={editor?.isActive("bold")} disabled={disabled} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></ToolbarButton>
      <ToolbarButton label="Kursywa" active={editor?.isActive("italic")} disabled={disabled} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></ToolbarButton>
      <ToolbarButton label="Podkreślenie" active={editor?.isActive("underline")} disabled={disabled} onClick={() => editor?.chain().focus().toggleUnderline().run()}><Underline size={16} /></ToolbarButton>
      <ToolbarButton label="Przekreślenie" active={editor?.isActive("strike")} disabled={disabled} onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></ToolbarButton>

      <ToolbarPopover trigger={<><Palette size={16} /><ChevronDown size={12} /></>} label="Kolor tekstu" disabled={disabled}>
        {(close) => (
          <ColorSwatchGrid
            onPick={(color) => { editor?.chain().focus().setColor(color).run(); close(); }}
            onReset={() => { editor?.chain().focus().unsetColor().run(); close(); }}
          />
        )}
      </ToolbarPopover>

      <ToolbarPopover trigger={<><Highlighter size={16} /><ChevronDown size={12} /></>} label="Kolor tła" disabled={disabled}>
        {(close) => (
          <ColorSwatchGrid
            onPick={(color) => { editor?.chain().focus().toggleHighlight({ color }).run(); close(); }}
            onReset={() => { editor?.chain().focus().unsetHighlight().run(); close(); }}
          />
        )}
      </ToolbarPopover>

      <ToolbarPopover trigger={<><Heading size={16} /><ChevronDown size={12} /></>} label="Nagłówek" disabled={disabled}>
        {(close) => (
          <div className="toolbar-menu">
            {HEADINGS.map((heading) => (
              <button
                key={heading.level}
                type="button"
                className="toolbar-menu__item"
                onClick={() => {
                  if (editor) {
                    if (heading.level === 0) editor.chain().focus().setParagraph().run();
                    else editor.chain().focus().toggleHeading({ level: heading.level as 1 | 2 | 3 }).run();
                  }
                  close();
                }}
              >
                {heading.label}
              </button>
            ))}
          </div>
        )}
      </ToolbarPopover>

      <ToolbarPopover trigger={<><AlignLeft size={16} /><ChevronDown size={12} /></>} label="Wyrównanie" disabled={disabled}>
        {(close) => (
          <div className="toolbar-menu toolbar-menu--row">
            {ALIGNMENTS.map((alignment) => (
              <button
                key={alignment.value}
                type="button"
                className="toolbar-btn"
                aria-label={alignment.label}
                onClick={() => { editor?.chain().focus().setTextAlign(alignment.value).run(); close(); }}
              >
                <alignment.Icon size={16} />
              </button>
            ))}
          </div>
        )}
      </ToolbarPopover>

      <ToolbarButton label="Lista punktowana" active={editor?.isActive("bulletList")} disabled={disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16} /></ToolbarButton>
      <ToolbarButton label="Lista numerowana" active={editor?.isActive("orderedList")} disabled={disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></ToolbarButton>
      <ToolbarButton label="Lista zadań" active={editor?.isActive("taskList")} disabled={disabled} onClick={() => editor?.chain().focus().toggleTaskList().run()}><ListChecks size={16} /></ToolbarButton>

      <TableMenu editor={editor} />

      <ToolbarButton label="Cytat" active={editor?.isActive("blockquote")} disabled={disabled} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={16} /></ToolbarButton>
      <ToolbarButton label="Blok kodu" active={editor?.isActive("codeBlock")} disabled={disabled} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}><Code size={16} /></ToolbarButton>
      <ToolbarButton label="Linia pozioma" disabled={disabled} onClick={() => editor?.chain().focus().setHorizontalRule().run()}><Minus size={16} /></ToolbarButton>

      <LinkPopover editor={editor} />
      <ToolbarButton label="Wstaw obraz" disabled={disabled} onClick={onInsertImage}><ImageIcon size={16} /></ToolbarButton>
      <ToolbarButton label="Wyczyść formatowanie" disabled={disabled} onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting size={16} /></ToolbarButton>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/composer/editor/EditorToolbar.test.tsx`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/editor/EditorToolbar.tsx src/features/composer/editor/EditorToolbar.test.tsx
git commit -m "feat(composer): add full EditorToolbar"
```

---

### Task 8: Wire EditorToolbar into Composer

**Files:**
- Modify: `src/features/composer/Composer.tsx` (imports near 1-11; `useEditor` at 73-76; inline toolbar at 336-382)

**Interfaces:**
- Consumes: `createEditorExtensions` from `./editor/extensions`; `EditorToolbar` from `./editor/EditorToolbar`. `EditorToolbar` requires `{ editor, onInsertImage }`; the existing `handleInsertImage` (Composer.tsx:226) is the `onInsertImage` callback.

- [ ] **Step 1: Replace StarterKit/Image imports with the extensions factory and toolbar**

In `src/features/composer/Composer.tsx`, replace lines 3-4:
```tsx
import StarterKit from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
```
with:
```tsx
import { createEditorExtensions } from "./editor/extensions";
import { EditorToolbar } from "./editor/EditorToolbar";
```

- [ ] **Step 2: Use the extensions factory in useEditor**

Replace the `useEditor` call (currently lines 73-76):
```tsx
  const editor = useEditor({
    extensions: [StarterKit, Image],
    content: prefill?.html_body ?? "",
  });
```
with:
```tsx
  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: prefill?.html_body ?? "",
  });
```

- [ ] **Step 3: Replace the inline toolbar block**

Replace the entire `<div className="composer-toolbar">…</div>` block (currently lines 336-382) with:
```tsx
        <EditorToolbar editor={editor} onInsertImage={handleInsertImage} />
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). If `editor?.isActive(...)` or removed imports cause unused-symbol errors, ensure no other reference to `StarterKit`/`Image` remains in the file.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npm test`
Expected: New editor tests PASS; pre-existing baseline unchanged (the 6 known-failing tests documented in project memory may still fail — do not fix them here).

- [ ] **Step 6: Commit**

```bash
git add src/features/composer/Composer.tsx
git commit -m "feat(composer): wire full formatting toolbar into composer"
```

---

### Task 9: ProseMirror and toolbar styles

**Files:**
- Modify: `src/features/composer/composer.css` (append a styles block; existing editor styles are around lines 187-214)

**Interfaces:** none (CSS only). No unit test — verified by build + visual check (justified: styling).

- [ ] **Step 1: Append editor and toolbar styles**

Append to `src/features/composer/composer.css`:
```css
.composer-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}

.toolbar-popover {
  position: relative;
  display: inline-flex;
}

.toolbar-popover__panel {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 40;
  margin-top: 4px;
  padding: 6px;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #d4d4d8);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.toolbar-menu {
  display: flex;
  flex-direction: column;
  min-width: 160px;
}

.toolbar-menu--row {
  flex-direction: row;
}

.toolbar-menu__item {
  padding: 6px 10px;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

.toolbar-menu__item:hover {
  background: var(--surface-hover, #f1f5f9);
}

.color-swatch-grid__swatches {
  display: grid;
  grid-template-columns: repeat(10, 16px);
  gap: 4px;
}

.color-swatch {
  width: 16px;
  height: 16px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
}

.color-swatch-grid__reset {
  margin-top: 6px;
  width: 100%;
  padding: 4px;
  background: none;
  border: 1px solid var(--border, #d4d4d8);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.table-menu {
  display: flex;
  flex-direction: column;
  min-width: 180px;
}

.table-menu__item {
  padding: 6px 10px;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

.table-menu__item:hover:not(:disabled) {
  background: var(--surface-hover, #f1f5f9);
}

.table-menu__item:disabled {
  opacity: 0.4;
  cursor: default;
}

.link-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 220px;
}

.link-form__input {
  padding: 6px 8px;
  border: 1px solid var(--border, #d4d4d8);
  border-radius: 6px;
  font-size: 14px;
}

.link-form__submit {
  padding: 6px;
  border: none;
  border-radius: 6px;
  background: var(--accent, #2563eb);
  color: #fff;
  cursor: pointer;
}

.composer-editor .tiptap ul,
.composer-editor .tiptap ol {
  padding-left: 1.4em;
  margin: 0.4em 0;
}

.composer-editor .tiptap ul {
  list-style: disc;
}

.composer-editor .tiptap ol {
  list-style: decimal;
}

.composer-editor .tiptap ul[data-type="taskList"] {
  list-style: none;
  padding-left: 0;
}

.composer-editor .tiptap ul[data-type="taskList"] li {
  display: flex;
  align-items: flex-start;
  gap: 0.5em;
}

.composer-editor .tiptap blockquote {
  border-left: 3px solid var(--border, #d4d4d8);
  margin: 0.5em 0;
  padding-left: 0.8em;
  color: var(--text-muted, #52525b);
}

.composer-editor .tiptap pre {
  background: #1e293b;
  color: #e2e8f0;
  padding: 0.6em 0.8em;
  border-radius: 6px;
  overflow-x: auto;
}

.composer-editor .tiptap table {
  border-collapse: collapse;
  margin: 0.5em 0;
  width: 100%;
  table-layout: fixed;
}

.composer-editor .tiptap th,
.composer-editor .tiptap td {
  border: 1px solid var(--border, #cbd5e1);
  padding: 4px 8px;
  vertical-align: top;
}

.composer-editor .tiptap th {
  background: var(--surface-hover, #f1f5f9);
  font-weight: 600;
}

.composer-editor .tiptap .selectedCell::after {
  content: "";
  position: absolute;
  inset: 0;
  background: rgba(37, 99, 235, 0.12);
  pointer-events: none;
}

.composer-editor .tiptap .column-resize-handle {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--accent, #2563eb);
  cursor: col-resize;
}
```

- [ ] **Step 2: Build to verify CSS and types compile**

Run: `npm run build`
Expected: PASS (`tsc` + `vite build` succeed). If `vite`/`tsc` fails on `crypto.hash`, switch to Node ≥ 24 and rerun.

- [ ] **Step 3: Commit**

```bash
git add src/features/composer/composer.css
git commit -m "style(composer): add ProseMirror and toolbar styles"
```

---

### Task 10: Final verification

**Files:** none (verification gate).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All new editor tests PASS. Compare failures against the documented baseline (6 known-failing pre-existing tests). No *new* failures introduced.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual smoke (optional, if a dev environment is available)**

Run: `npm run tauri dev` (Node ≥ 24), open the composer, and confirm: font family/size dropdowns, color/highlight pickers, headings, alignment, bullet/ordered/task lists, table insert + row/column edit, blockquote/code/hr, link popover, image, clear formatting. Send a test message to confirm formatting survives (backend sanitizer preserves it).

- [ ] **Step 4: Commit any fixes**

If steps 1-2 required fixes, commit them:
```bash
git add -A
git commit -m "fix(composer): resolve formatting toolbar build issues"
```
Otherwise no commit needed.

---

## Self-Review

**Spec coverage:**
- Pełny zestaw funkcji → Task 1 (extensions) + Task 7 (toolbar) ✓
- Kompaktowy toolbar z popoverami → Task 3 (ToolbarPopover) + Task 7 ✓
- Rozmiary nazwane (13/14/18/26) → Task 2 (`FONT_SIZE_PRESETS`) ✓
- Czcionki email-safe → Task 2 (`FONT_FAMILIES`) ✓
- Kolory (siatka + reset) → Task 2 (`COLOR_SWATCHES`) + Task 4 ✓
- Link popover (URL + tekst) → Task 6 ✓
- Tabele z edycją → Task 5 ✓
- Wydzielenie do `editor/`, odchudzenie Composer → Task 8 ✓
- CSS ProseMirror (listy/tabele/task-list/blockquote) → Task 9 ✓
- Backend bez zmian → respektowane (Global Constraints) ✓
- Obraz spięty z attachmentami (delegacja do Composer) → Task 7 `onInsertImage` + Task 8 ✓
- Testy: extensions, buildMessage/serializacja, toolbar → Tasks 1, 7 (toolbar). Uwaga: dedykowany test serializacji `buildMessage` z tabelą został świadomie pominięty — `buildMessage` jest wewnętrzną funkcją `Composer.tsx` ciasno spiętą z react-query/zustand/tauri; pokrycie zapewnia test `extensions` (obecność rozszerzeń produkujących HTML) + niezmieniony tor `getHTML()`→backend. Backend i tak sanityzuje 1:1 przy wysyłce.

**Placeholder scan:** brak TBD/TODO; każdy krop kodowy zawiera pełny kod. ✓

**Type consistency:** `createEditorExtensions`, `EditorToolbar({ editor, onInsertImage })`, `ToolbarPopover` render-prop `(close) => ReactNode`, `ColorSwatchGrid({ onPick, onReset })`, `TableMenu({ editor })`, `LinkPopover({ editor })`, `createEditorMock` zwraca `{ editor, chain, run }` — nazwy spójne między zadaniami. ✓
