# Quoted History Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** W treści maila z cytowaną historią zwijać poprzednią korespondencję pod jeden przycisk „•••" (styl Gmail), domyślnie zwinięte, dla HTML i plain-text.

**Architecture:** Czysty moduł TS (`quotedHistory.ts`) wykrywa granicę cytatu i dzieli treść na `collapsed`/`full`. `MessageBodyView` trzyma stan `expanded` i przekazuje odpowiedni string do `SafeHtmlFrame` (HTML) lub `<pre>` (plain-text). Przycisk-toggle to element React pod treścią — żadnego JS w sandboxowanym iframe, działa we wszystkich poziomach bezpieczeństwa.

**Tech Stack:** React + TypeScript, Vitest (`happy-dom`), `@testing-library/react`, natywny `DOMParser`.

## Global Constraints

- Wszystkie identyfikatory w kodzie po angielsku; tekst UI dla użytkownika po polsku.
- Zero komentarzy w kodzie.
- Conventional Commits 1.0.0; bez co-authora; bez `push`.
- Backend / typy IPC bez zmian.
- Komenda testów pojedynczego pliku: `npx vitest run <ścieżka>`.
- iframe nigdy nie polega na `allow-scripts` ani na dostępie do `contentDocument` — toggle steruje wyłącznie stringiem `srcDoc`.

---

### Task 1: Moduł detekcji — plain-text + współdzielone heurystyki

**Files:**
- Create: `src/shared/quotedHistory.ts`
- Test: `src/shared/quotedHistory.test.ts`

**Interfaces:**
- Produces:
  - `type QuoteSplit = { collapsed: string; full: string; hasHistory: boolean }`
  - `splitTextHistory(text: string): QuoteSplit`
  - `isAttributionText(value: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/shared/quotedHistory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { splitTextHistory, isAttributionText } from "./quotedHistory";

describe("isAttributionText", () => {
  it("matches English 'On … wrote:'", () => {
    expect(isAttributionText("On Mon, Jun 23, 2026 at 10:00 AM John <j@x.com> wrote:")).toBe(true);
  });
  it("matches Polish 'W dniu … pisze:'", () => {
    expect(isAttributionText("W dniu 23.06.2026 o 10:00, Jan Kowalski pisze:")).toBe(true);
  });
  it("matches an Outlook header block on one line", () => {
    expect(isAttributionText("From: a@x.com Sent: Monday To: b@y.com Subject: Hi")).toBe(true);
  });
  it("rejects ordinary prose ending in a colon", () => {
    expect(isAttributionText("On Monday we shipped the feature:")).toBe(false);
  });
});

describe("splitTextHistory", () => {
  it("collapses from the first '>'-quoted block", () => {
    const text = "Thanks, that works.\n\n> previous line one\n> previous line two";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toBe("Thanks, that works.");
    expect(r.full).toBe(text);
  });

  it("collapses from a Polish attribution line", () => {
    const text = "Dziękuję.\n\nW dniu 23.06.2026 o 10:00, Jan pisze:\nstara treść";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toBe("Dziękuję.");
  });

  it("collapses from a multi-line From/Sent/To header block", () => {
    const text = "Reply body\n\nFrom: a@x.com\nSent: Monday\nTo: b@y.com\nSubject: Hi\nold body";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toBe("Reply body");
  });

  it("returns no history when there is no quote", () => {
    const text = "Just a plain note with no history.";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(false);
    expect(r.collapsed).toBe(text);
    expect(r.full).toBe(text);
  });

  it("does not collapse when the whole body is a quote (empty reply guard)", () => {
    const text = "> only quoted content\n> second line";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(false);
    expect(r.collapsed).toBe(text);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/quotedHistory.test.ts`
Expected: FAIL — `Failed to resolve import "./quotedHistory"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/quotedHistory.ts`:

```ts
export type QuoteSplit = { collapsed: string; full: string; hasHistory: boolean };

const ATTRIBUTION_PATTERNS: RegExp[] = [
  /^on\b.{0,240}\bwrote:\s*$/i,
  /^w dniu\b.{0,240}\b(?:pisze|napisał(?:a|\(a\))?)\s*:\s*$/i,
  /^dnia\b.{0,240}\bnapisał(?:a|\(a\))?\s*:\s*$/i,
  /^wiadomość napisana przez\b.{0,240}:\s*$/i,
  /^am\b.{0,240}\bschrieb:\s*$/i,
  /^-{2,}\s*(?:original message|wiadomość oryginalna|ursprüngliche nachricht)\s*-{2,}\s*$/i,
];

const HEADER_BLOCK = /^(?:from|od|von):\s.*\b(?:sent|wysłano|gesendet):/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isAttributionText(value: string): boolean {
  const text = normalizeWhitespace(value);
  if (text.length === 0) return false;
  if (HEADER_BLOCK.test(text)) return true;
  if (text.length > 280) return false;
  return ATTRIBUTION_PATTERNS.some((re) => re.test(text));
}

function isHeaderBlockStart(lines: string[], index: number): boolean {
  if (!/^\s*(?:from|od|von):\s*\S/i.test(lines[index])) return false;
  const window = lines.slice(index + 1, index + 6).join("\n");
  return /^\s*(?:sent|wysłano|gesendet|to|do|an):/im.test(window);
}

export function splitTextHistory(text: string): QuoteSplit {
  const full = text;
  const lines = text.split("\n");
  let boundary = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i]) || isAttributionText(lines[i]) || isHeaderBlockStart(lines, i)) {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) return { collapsed: full, full, hasHistory: false };
  const collapsed = lines.slice(0, boundary).join("\n").replace(/\s+$/, "");
  if (collapsed.trim().length === 0) return { collapsed: full, full, hasHistory: false };
  return { collapsed, full, hasHistory: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/quotedHistory.test.ts`
Expected: PASS (9 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/shared/quotedHistory.ts src/shared/quotedHistory.test.ts
git commit -m "feat(reader): detect quoted history in plain-text bodies"
```

---

### Task 2: Moduł detekcji — HTML

**Files:**
- Modify: `src/shared/quotedHistory.ts`
- Test: `src/shared/quotedHistory.test.ts` (dopisać blok)

**Interfaces:**
- Consumes: `isAttributionText`, `QuoteSplit` (Task 1)
- Produces: `splitHtmlHistory(html: string): QuoteSplit`

- [ ] **Step 1: Write the failing test**

Dopisz na końcu `src/shared/quotedHistory.test.ts`:

```ts
import { splitHtmlHistory } from "./quotedHistory";

describe("splitHtmlHistory", () => {
  it("collapses a Gmail gmail_quote container", () => {
    const html =
      '<div>My reply.</div>' +
      '<div class="gmail_quote"><div class="gmail_attr">On Mon wrote:</div>' +
      '<blockquote>old</blockquote></div>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("My reply.");
    expect(r.collapsed).not.toContain("gmail_quote");
    expect(r.collapsed).not.toContain("old");
    expect(r.full).toBe(html);
  });

  it("collapses an Outlook reply divider", () => {
    const html =
      '<div>Reply here</div>' +
      '<div id="divRplyFwdMsg"><b>From:</b> a@x.com</div><div>quoted body</div>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("Reply here");
    expect(r.collapsed).not.toContain("quoted body");
  });

  it("collapses an Apple Mail blockquote[type=cite]", () => {
    const html = '<div>Sure.</div><blockquote type="cite">old thread</blockquote>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("Sure.");
    expect(r.collapsed).not.toContain("old thread");
  });

  it("collapses via attribution fallback when no known class is present", () => {
    const html =
      '<p>New message</p><p>W dniu 23.06.2026 o 10:00, Jan pisze:</p>' +
      '<p>poprzednia treść</p>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("New message");
    expect(r.collapsed).not.toContain("poprzednia treść");
  });

  it("returns no history when there is no quote", () => {
    const html = "<p>Standalone message, nothing quoted.</p>";
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(false);
    expect(r.collapsed).toBe(html);
  });

  it("keeps an image-only reply (does not treat it as empty)", () => {
    const html =
      '<div><img src="cid:logo"></div>' +
      '<blockquote type="cite">old thread</blockquote>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("<img");
  });

  it("does not collapse when the whole body is a quote (empty reply guard)", () => {
    const html = '<blockquote type="cite">entire body is quoted</blockquote>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(false);
    expect(r.collapsed).toBe(html);
  });

  it("falls back to full content on unparseable input without throwing", () => {
    const html = "<<< not really html >>>";
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(false);
    expect(r.full).toBe(html);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/quotedHistory.test.ts`
Expected: FAIL — `splitHtmlHistory is not exported` / `is not a function`.

- [ ] **Step 3: Write minimal implementation**

Dopisz do `src/shared/quotedHistory.ts`:

```ts
const QUOTE_SELECTORS = [
  ".gmail_quote",
  ".gmail_quote_container",
  "#appendonsend",
  "#divRplyFwdMsg",
  'blockquote[type="cite"]',
  ".moz-cite-prefix",
  ".yahoo_quoted",
  "#yahoo_quoted",
  ".protonmail_quote",
].join(",");

function findHtmlBoundary(body: HTMLElement): Element | null {
  const selectorMatch = body.querySelector(QUOTE_SELECTORS);
  let attributionMatch: Element | null = null;
  for (const element of Array.from(body.querySelectorAll("*"))) {
    if (isAttributionText(element.textContent ?? "")) {
      attributionMatch = element;
      break;
    }
  }
  if (selectorMatch && attributionMatch) {
    const position = selectorMatch.compareDocumentPosition(attributionMatch);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? attributionMatch : selectorMatch;
  }
  return selectorMatch ?? attributionMatch;
}

function cutFromBoundary(boundary: Element, body: HTMLElement): void {
  let node: Node | null = boundary;
  while (node && node !== body) {
    let sibling = node.nextSibling;
    while (sibling) {
      const next = sibling.nextSibling;
      sibling.parentNode?.removeChild(sibling);
      sibling = next;
    }
    node = node.parentNode;
  }
  boundary.parentNode?.removeChild(boundary);
}

function isMeaningfullyEmpty(body: HTMLElement): boolean {
  const hasText = (body.textContent ?? "").replace(/\s+/g, "").length > 0;
  const hasMedia = body.querySelector("img,table,hr,video,iframe") !== null;
  return !hasText && !hasMedia;
}

export function splitHtmlHistory(html: string): QuoteSplit {
  const full = html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.body;
    const boundary = findHtmlBoundary(body);
    if (!boundary) return { collapsed: full, full, hasHistory: false };
    cutFromBoundary(boundary, body);
    if (isMeaningfullyEmpty(body)) return { collapsed: full, full, hasHistory: false };
    return { collapsed: body.innerHTML, full, hasHistory: true };
  } catch {
    return { collapsed: full, full, hasHistory: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/quotedHistory.test.ts`
Expected: PASS (cały plik, łącznie z testami Task 1).

- [ ] **Step 5: Commit**

```bash
git add src/shared/quotedHistory.ts src/shared/quotedHistory.test.ts
git commit -m "feat(reader): detect quoted history in HTML bodies"
```

---

### Task 3: Komponent przycisku QuotedHistoryToggle

**Files:**
- Create: `src/features/reader/QuotedHistoryToggle.tsx`
- Test: `src/features/reader/QuotedHistoryToggle.test.tsx`

**Interfaces:**
- Produces: `QuotedHistoryToggle({ expanded: boolean; onToggle: () => void })`

- [ ] **Step 1: Write the failing test**

Create `src/features/reader/QuotedHistoryToggle.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QuotedHistoryToggle } from "./QuotedHistoryToggle";

describe("QuotedHistoryToggle", () => {
  afterEach(cleanup);

  it("shows the expand label and dots when collapsed", () => {
    render(<QuotedHistoryToggle expanded={false} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "Pokaż cytowaną historię" });
    expect(button).toHaveTextContent("•••");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the hide label when expanded", () => {
    render(<QuotedHistoryToggle expanded={true} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "Ukryj cytowaną historię" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(<QuotedHistoryToggle expanded={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Pokaż cytowaną historię" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/reader/QuotedHistoryToggle.test.tsx`
Expected: FAIL — `Failed to resolve import "./QuotedHistoryToggle"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/features/reader/QuotedHistoryToggle.tsx`:

```tsx
export function QuotedHistoryToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = expanded ? "Ukryj cytowaną historię" : "Pokaż cytowaną historię";
  return (
    <button
      type="button"
      className="quoted-history-toggle"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {expanded ? label : "•••"}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/reader/QuotedHistoryToggle.test.tsx`
Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/QuotedHistoryToggle.tsx src/features/reader/QuotedHistoryToggle.test.tsx
git commit -m "feat(reader): add quoted-history toggle button"
```

---

### Task 4: Integracja w MessageBodyView + style

**Files:**
- Modify: `src/features/reader/MessageBodyView.tsx`
- Modify: `src/features/reader/reader.css`
- Test: `src/features/reader/MessageBodyView.test.tsx` (dopisać blok)

**Interfaces:**
- Consumes: `splitHtmlHistory`, `splitTextHistory` (Task 1–2), `QuotedHistoryToggle` (Task 3)

- [ ] **Step 1: Write the failing test**

Dopisz na końcu `src/features/reader/MessageBodyView.test.tsx` (plik mockuje już `../../ipc/bindings`):

```tsx
describe("MessageBodyView — quoted history collapse", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("collapses HTML history by default and expands on click", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "balanced"]],
    });
    (commands.renderMessageHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: {
        html:
          '<div>Visible reply</div>' +
          '<div class="gmail_quote"><div class="gmail_attr">On Mon wrote:</div>' +
          "<blockquote>hidden history</blockquote></div>",
        blocked_remote_content: false,
        remote_loaded: false,
      },
    });

    render(<MessageBodyView messageId={7} />, { wrapper: Wrapper });

    const frame = await screen.findByTitle("message-content");
    expect(frame.getAttribute("srcdoc")).toContain("Visible reply");
    expect(frame.getAttribute("srcdoc")).not.toContain("hidden history");

    fireEvent.click(screen.getByRole("button", { name: "Pokaż cytowaną historię" }));

    await waitFor(() =>
      expect(screen.getByTitle("message-content").getAttribute("srcdoc")).toContain("hidden history")
    );
  });

  it("shows no toggle when the HTML has no quoted history", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "balanced"]],
    });
    (commands.renderMessageHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: { html: "<p>No quotes here</p>", blocked_remote_content: false, remote_loaded: false },
    });

    render(<MessageBodyView messageId={8} />, { wrapper: Wrapper });

    await screen.findByTitle("message-content");
    expect(screen.queryByRole("button", { name: /cytowaną historię/ })).toBeNull();
  });

  it("collapses plain-text history by default and expands on click", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "balanced"]],
    });
    (commands.renderMessageHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: { html: null, blocked_remote_content: false, remote_loaded: false },
    });
    (commands.getMessageBody as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: {
        message_id: 9,
        text_plain: "Visible reply text\n\n> hidden quoted line",
        text_html: null,
      },
    });

    render(<MessageBodyView messageId={9} />, { wrapper: Wrapper });

    await screen.findByText((t) => t.includes("Visible reply text"));
    expect(screen.queryByText((t) => t.includes("hidden quoted line"))).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pokaż cytowaną historię" }));

    await screen.findByText((t) => t.includes("hidden quoted line"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/reader/MessageBodyView.test.tsx`
Expected: FAIL — brak przycisku „Pokaż cytowaną historię"; `srcdoc` zawiera „hidden history" mimo zwinięcia.

- [ ] **Step 3: Write minimal implementation**

Zamień całą zawartość `src/features/reader/MessageBodyView.tsx` na:

```tsx
import { useState, useEffect, useMemo } from "react";
import { useRenderedMessage, useMessageBody, useContentSecurityLevel } from "../../ipc/queries";
import { SafeHtmlFrame } from "./SafeHtmlFrame";
import { QuotedHistoryToggle } from "./QuotedHistoryToggle";
import { splitHtmlHistory, splitTextHistory } from "../../shared/quotedHistory";
import {
  sandboxForLevel,
  interceptLinksForLevel,
  autoloadRemoteForLevel,
  DEFAULT_CONTENT_SECURITY_LEVEL,
} from "../../shared/contentSecurity";

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
  const { data: level = DEFAULT_CONTENT_SECURITY_LEVEL } = useContentSecurityLevel();
  const [forceLoadRemote, setForceLoadRemote] = useState(autoloadRemoteForLevel(level));
  const { data: rendered, isLoading: renderLoading } = useRenderedMessage(messageId, forceLoadRemote);
  const { data: body, isLoading: bodyLoading } = useMessageBody(messageId);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setForceLoadRemote(autoloadRemoteForLevel(level));
  }, [messageId, level]);

  useEffect(() => {
    setExpanded(false);
  }, [messageId]);

  const htmlSplit = useMemo(
    () => (rendered?.html != null ? splitHtmlHistory(rendered.html) : null),
    [rendered?.html]
  );
  const textSplit = useMemo(
    () => (body?.text_plain != null ? splitTextHistory(body.text_plain) : null),
    [body?.text_plain]
  );

  if (renderLoading && rendered == null) {
    return <p className="loading-state">Loading…</p>;
  }

  if (htmlSplit) {
    return (
      <div className="message-body">
        {rendered?.blocked_remote_content && <RemoteContentBanner onLoad={() => setForceLoadRemote(true)} />}
        <SafeHtmlFrame
          html={expanded ? htmlSplit.full : htmlSplit.collapsed}
          sandbox={sandboxForLevel(level)}
          interceptLinks={interceptLinksForLevel(level)}
          autoResize
        />
        {htmlSplit.hasHistory && (
          <QuotedHistoryToggle expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
        )}
      </div>
    );
  }

  if (bodyLoading) {
    return <p className="loading-state">Loading…</p>;
  }

  if (textSplit) {
    return (
      <div className="message-body">
        <pre className="plain-text-body">{expanded ? textSplit.full : textSplit.collapsed}</pre>
        {textSplit.hasHistory && (
          <QuotedHistoryToggle expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
        )}
      </div>
    );
  }

  return <p className="empty-state">No content available</p>;
}
```

Dopisz na końcu `src/features/reader/reader.css`:

```css
.quoted-history-toggle {
  align-self: flex-start;
  margin: var(--space-2) 0 var(--space-1) var(--space-4);
  padding: 2px 12px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 13px;
  line-height: 1.6;
  cursor: pointer;
}

.quoted-history-toggle:hover {
  background: var(--bg-surface);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/reader/MessageBodyView.test.tsx`
Expected: PASS (istniejące 4 testy + 3 nowe).

Następnie pełny pakiet (sprawdzenie regresji):
Run: `npm test`
Expected: brak NOWYCH błędów względem znanego baseline (6 wcześniej niebieskich testów: ConversationView ×3, useDebouncedValue ×3).

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/MessageBodyView.tsx src/features/reader/reader.css src/features/reader/MessageBodyView.test.tsx
git commit -m "feat(reader): collapse quoted history in message body"
```

---

## Self-Review

**Spec coverage:**
- Jeden toggle od pierwszej granicy → Task 2 `findHtmlBoundary` (pierwsze trafienie) + Task 1 `splitTextHistory` (pierwsza linia-granica). ✓
- HTML i plain-text → Task 2 / Task 1, zintegrowane w Task 4. ✓
- Domyślnie zwinięte → Task 4 `useState(false)`. ✓
- Selektory per klient + regex atrybucji PL/EN/DE → Task 1 `ATTRIBUTION_PATTERNS`/`HEADER_BLOCK`, Task 2 `QUOTE_SELECTORS`. ✓
- Guard pustej odpowiedzi → Task 1 (`collapsed.trim()`) + Task 2 `isMeaningfullyEmpty` (z wyjątkiem media). ✓
- Malformed HTML fallback → Task 2 `try/catch`. ✓
- Reset stanu przy zmianie maila → Task 4 `useEffect([messageId])`. ✓
- Działa w Strict / brak JS w iframe → Task 4 podmiana `srcDoc`, brak `contentDocument`. ✓
- Współistnienie z banerem remote-content → Task 4 (baner nad ramką, toggle pod). ✓
- Testy: fixtury per klient, PL/EN, plain-text, brak cytatu, guard, malformed → Task 1–2; zachowanie UI → Task 4. ✓

**Placeholder scan:** Brak TODO/TBD; każdy krok ma pełny kod i komendy. ✓

**Type consistency:** `QuoteSplit { collapsed, full, hasHistory }`, `splitHtmlHistory`, `splitTextHistory`, `isAttributionText`, `QuotedHistoryToggle({ expanded, onToggle })` — nazwy spójne w Task 1→4. ✓
