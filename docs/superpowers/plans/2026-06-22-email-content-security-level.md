# Email Content Security Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global, user-selectable email-content security level (Strict / Balanced / Open) that controls the reader iframe's sandbox, external-link opening, and the remote-image baseline.

**Architecture:** A pure shared module maps the level to sandbox tokens / behavior flags. `SafeHtmlFrame` gains opt-in `sandbox` + `interceptLinks` props (defaults preserve today's fully-locked behavior). The reader (`MessageBodyView`) reads the level and applies it; link clicks are intercepted in the parent (only possible at non-strict levels, which use `allow-same-origin`) and routed to the existing `open_external_url` backend allowlist. The level is persisted in the settings table and surfaced in Settings → General. The per-account image toggle stays as an override and is disabled at the Open level.

**Tech Stack:** React + TypeScript, TanStack Query, Vitest + Testing Library (happy-dom), Tauri command `open_external_url` (https/tel allowlist, already implemented).

## Global Constraints

- All code identifiers and UI copy in English.
- No code comments; if something needs explaining it belongs in `docs/`.
- Security invariant: the email-body iframe must NEVER receive `allow-scripts` at any level.
- `allow-same-origin` only at Balanced/Open (user-opted lower security); scripts remain off regardless.
- External link opening reuses backend `open_external_url` (accepts only `https://` and `tel:`).
- `SafeHtmlFrame` default props stay fully locked (`sandbox=""`, no link interception) so signature previews are unchanged.
- Default level is Balanced; absent setting parses to Balanced.
- Setting key: `reader.contentSecurity`.
- Conventional Commits; do not add a co-author.

---

### Task 1: Shared content-security module

**Files:**
- Create: `src/shared/contentSecurity.ts`
- Test: `src/shared/contentSecurity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ContentSecurityLevel = "strict" | "balanced" | "open"`
  - `DEFAULT_CONTENT_SECURITY_LEVEL: ContentSecurityLevel` (= `"balanced"`)
  - `CONTENT_SECURITY_LEVELS: { value: ContentSecurityLevel; label: string; description: string }[]`
  - `sandboxForLevel(level: ContentSecurityLevel): string`
  - `interceptLinksForLevel(level: ContentSecurityLevel): boolean`
  - `autoloadRemoteForLevel(level: ContentSecurityLevel): boolean`
  - `isExternalLink(href: string): boolean`
  - `parseContentSecurityLevel(value: string | undefined): ContentSecurityLevel`

- [ ] **Step 1: Write the failing test**

Create `src/shared/contentSecurity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CONTENT_SECURITY_LEVELS,
  DEFAULT_CONTENT_SECURITY_LEVEL,
  sandboxForLevel,
  interceptLinksForLevel,
  autoloadRemoteForLevel,
  isExternalLink,
  parseContentSecurityLevel,
  type ContentSecurityLevel,
} from "./contentSecurity";

const LEVELS: ContentSecurityLevel[] = ["strict", "balanced", "open"];

describe("contentSecurity", () => {
  it("SECURITY: no level ever grants allow-scripts", () => {
    for (const level of LEVELS) {
      expect(sandboxForLevel(level)).not.toContain("allow-scripts");
    }
  });

  it("maps sandbox tokens per level", () => {
    expect(sandboxForLevel("strict")).toBe("");
    expect(sandboxForLevel("balanced")).toBe("allow-same-origin");
    expect(sandboxForLevel("open")).toBe("allow-same-origin");
  });

  it("intercepts links at non-strict levels only", () => {
    expect(interceptLinksForLevel("strict")).toBe(false);
    expect(interceptLinksForLevel("balanced")).toBe(true);
    expect(interceptLinksForLevel("open")).toBe(true);
  });

  it("auto-loads remote images only at the open level", () => {
    expect(autoloadRemoteForLevel("strict")).toBe(false);
    expect(autoloadRemoteForLevel("balanced")).toBe(false);
    expect(autoloadRemoteForLevel("open")).toBe(true);
  });

  it("recognizes only https and tel links as external", () => {
    expect(isExternalLink("https://example.com")).toBe(true);
    expect(isExternalLink("HTTPS://EXAMPLE.COM")).toBe(true);
    expect(isExternalLink("tel:+48123")).toBe(true);
    expect(isExternalLink("http://insecure.test")).toBe(false);
    expect(isExternalLink("mailto:a@b.c")).toBe(false);
    expect(isExternalLink("javascript:alert(1)")).toBe(false);
    expect(isExternalLink("/relative")).toBe(false);
    expect(isExternalLink("")).toBe(false);
  });

  it("parses stored values and falls back to the default", () => {
    expect(parseContentSecurityLevel("strict")).toBe("strict");
    expect(parseContentSecurityLevel("open")).toBe("open");
    expect(parseContentSecurityLevel(undefined)).toBe(DEFAULT_CONTENT_SECURITY_LEVEL);
    expect(parseContentSecurityLevel("garbage")).toBe(DEFAULT_CONTENT_SECURITY_LEVEL);
  });

  it("exposes all three levels for the settings UI", () => {
    expect(CONTENT_SECURITY_LEVELS.map((l) => l.value)).toEqual(["strict", "balanced", "open"]);
    for (const l of CONTENT_SECURITY_LEVELS) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.description.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/contentSecurity.test.ts`
Expected: FAIL — cannot resolve `./contentSecurity`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/contentSecurity.ts`:

```ts
export type ContentSecurityLevel = "strict" | "balanced" | "open";

export const DEFAULT_CONTENT_SECURITY_LEVEL: ContentSecurityLevel = "balanced";

export const CONTENT_SECURITY_LEVELS: {
  value: ContentSecurityLevel;
  label: string;
  description: string;
}[] = [
  {
    value: "strict",
    label: "Strict",
    description:
      "Maximum isolation. External links are disabled and remote images stay blocked unless enabled per account.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description:
      "Links open in your system browser and scripts never run. Remote images follow each account's setting.",
  },
  {
    value: "open",
    label: "Open",
    description:
      "Links open in your system browser and remote images load for every account. Scripts never run.",
  },
];

export function sandboxForLevel(level: ContentSecurityLevel): string {
  return level === "strict" ? "" : "allow-same-origin";
}

export function interceptLinksForLevel(level: ContentSecurityLevel): boolean {
  return level !== "strict";
}

export function autoloadRemoteForLevel(level: ContentSecurityLevel): boolean {
  return level === "open";
}

export function isExternalLink(href: string): boolean {
  const lower = href.trim().toLowerCase();
  return lower.startsWith("https://") || lower.startsWith("tel:");
}

export function parseContentSecurityLevel(value: string | undefined): ContentSecurityLevel {
  return value === "strict" || value === "balanced" || value === "open"
    ? value
    : DEFAULT_CONTENT_SECURITY_LEVEL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/contentSecurity.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/contentSecurity.ts src/shared/contentSecurity.test.ts
git commit -m "feat(reader): add content-security level model"
```

---

### Task 2: SafeHtmlFrame opt-in sandbox + link interception

**Files:**
- Modify: `src/features/reader/SafeHtmlFrame.tsx`
- Test: `src/features/reader/SafeHtmlFrame.test.tsx`

**Interfaces:**
- Consumes: `isExternalLink` from `src/shared/contentSecurity` (Task 1); `commands.openExternalUrl` from `src/ipc/bindings`.
- Produces: `SafeHtmlFrame` now accepts optional props `sandbox?: string` (default `""`) and `interceptLinks?: boolean` (default `false`). Behavior with no new props is identical to today.

- [ ] **Step 1: Write the failing tests**

Replace `src/features/reader/SafeHtmlFrame.test.tsx` with:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { SafeHtmlFrame } from "./SafeHtmlFrame";
import { commands } from "../../ipc/bindings";

vi.mock("../../ipc/bindings", () => ({
  commands: { openExternalUrl: vi.fn().mockResolvedValue({ status: "ok", data: null }) },
}));

async function getAnchor(): Promise<{ frame: HTMLIFrameElement; anchor: HTMLAnchorElement }> {
  const frame = document.querySelector("iframe") as HTMLIFrameElement;
  const anchor = await waitFor(() => {
    const a = frame.contentDocument?.querySelector("a");
    expect(a).toBeTruthy();
    return a as HTMLAnchorElement;
  });
  return { frame, anchor };
}

function clickInFrame(frame: HTMLIFrameElement, anchor: HTMLAnchorElement) {
  const MouseEventCtor = (frame.contentWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  anchor.dispatchEvent(new MouseEventCtor("click", { bubbles: true, cancelable: true }));
}

describe("SafeHtmlFrame", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders an iframe with the provided html as srcDoc", () => {
    const html = "<p>hi</p>";
    render(<SafeHtmlFrame html={html} />);
    const iframe = document.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute("srcdoc")).toBe(html);
  });

  it("SECURITY: default sandbox is present and empty", () => {
    render(<SafeHtmlFrame html="<p>test</p>" />);
    const iframe = document.querySelector("iframe");
    expect(iframe!.hasAttribute("sandbox")).toBe(true);
    expect(iframe!.getAttribute("sandbox")).toBe("");
  });

  it("SECURITY: never emits allow-scripts even when a sandbox is supplied", () => {
    render(<SafeHtmlFrame html="<p>test</p>" sandbox="allow-same-origin" />);
    const sandbox = document.querySelector("iframe")!.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
  });

  it("opens https links in the system browser when interceptLinks is on", async () => {
    render(
      <SafeHtmlFrame
        html={'<a href="https://example.com/x">link</a>'}
        sandbox="allow-same-origin"
        interceptLinks
      />
    );
    const { frame, anchor } = await getAnchor();
    clickInFrame(frame, anchor);
    expect(commands.openExternalUrl).toHaveBeenCalledWith("https://example.com/x");
  });

  it("ignores non-https/tel links", async () => {
    render(
      <SafeHtmlFrame
        html={'<a href="http://insecure.test/x">link</a>'}
        sandbox="allow-same-origin"
        interceptLinks
      />
    );
    const { frame, anchor } = await getAnchor();
    clickInFrame(frame, anchor);
    expect(commands.openExternalUrl).not.toHaveBeenCalled();
  });

  it("does not intercept clicks when interceptLinks is off", async () => {
    render(
      <SafeHtmlFrame html={'<a href="https://example.com/x">link</a>'} sandbox="allow-same-origin" />
    );
    const { frame, anchor } = await getAnchor();
    clickInFrame(frame, anchor);
    expect(commands.openExternalUrl).not.toHaveBeenCalled();
  });
});
```

(Note: the "ignores non-https/tel" case lets the default click proceed; happy-dom may log a harmless aborted-navigation warning. The assertion still holds.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/reader/SafeHtmlFrame.test.tsx`
Expected: FAIL — `SafeHtmlFrame` does not accept `interceptLinks`/`sandbox`; `openExternalUrl` not called.

- [ ] **Step 3: Write the implementation**

Replace `src/features/reader/SafeHtmlFrame.tsx` with:

```tsx
import { useEffect, useRef } from "react";
import { commands } from "../../ipc/bindings";
import { isExternalLink } from "../../shared/contentSecurity";

export function SafeHtmlFrame({
  html,
  title = "message-content",
  className = "reader-frame",
  sandbox = "",
  interceptLinks = false,
}: {
  html: string;
  title?: string;
  className?: string;
  sandbox?: string;
  interceptLinks?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!interceptLinks) return;
    const frame = frameRef.current;
    if (!frame) return;

    function handleClick(event: MouseEvent) {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!isExternalLink(href)) return;
      event.preventDefault();
      void commands.openExternalUrl(href);
    }

    function attach() {
      frame.contentDocument?.addEventListener("click", handleClick);
    }

    frame.addEventListener("load", attach);
    attach();

    return () => {
      frame.removeEventListener("load", attach);
      frame.contentDocument?.removeEventListener("click", handleClick);
    };
  }, [html, interceptLinks]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={sandbox}
      srcDoc={html}
      className={className}
    />
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/reader/SafeHtmlFrame.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/SafeHtmlFrame.tsx src/features/reader/SafeHtmlFrame.test.tsx
git commit -m "feat(reader): opt-in sandbox relaxation and external link interception in SafeHtmlFrame"
```

---

### Task 3: Persistence hooks + General settings control

**Files:**
- Modify: `src/ipc/queries.ts` (add two hooks after `useSetImageAutoload`, ~line 123; add import)
- Modify: `src/features/settings/GeneralSection.tsx`
- Modify: `src/features/settings/Settings.css` (add `.settings-field__hint`)
- Test: `src/features/settings/GeneralSection.test.tsx`

**Interfaces:**
- Consumes: `ContentSecurityLevel`, `parseContentSecurityLevel`, `CONTENT_SECURITY_LEVELS`, `DEFAULT_CONTENT_SECURITY_LEVEL` from `src/shared/contentSecurity` (Task 1).
- Produces:
  - `useContentSecurityLevel(): UseQueryResult<ContentSecurityLevel>` (query key `["content-security-level"]`)
  - `useSetContentSecurityLevel(): UseMutationResult` with `mutate(level: ContentSecurityLevel)`

- [ ] **Step 1: Add the hooks to `src/ipc/queries.ts`**

At the top of `src/ipc/queries.ts`, add the import (next to existing imports):

```ts
import {
  parseContentSecurityLevel,
  type ContentSecurityLevel,
} from "../shared/contentSecurity";
```

Immediately after the `useSetImageAutoload` function (ends ~line 123), add:

```ts
const CONTENT_SECURITY_KEY = "reader.contentSecurity";

export function useContentSecurityLevel() {
  return useQuery({
    queryKey: ["content-security-level"],
    queryFn: () =>
      commands
        .getSettings()
        .then(unwrap)
        .then((all) => {
          const found = all.find(([k]) => k === CONTENT_SECURITY_KEY);
          return parseContentSecurityLevel(found?.[1]);
        }),
  });
}

export function useSetContentSecurityLevel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (level: ContentSecurityLevel) =>
      commands.setSetting(CONTENT_SECURITY_KEY, level).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["content-security-level"] });
    },
  });
}
```

- [ ] **Step 2: Write the failing test**

Edit `src/features/settings/GeneralSection.test.tsx`. Extend the `vi.hoisted` block to add `setContentSecurity`:

```tsx
const { state, setDefaultAccountId, setTimeFormat, setMarkReadMode, setMarkReadDelaySeconds, setContentSecurity } = vi.hoisted(() => ({
  state: { markReadMode: "immediate" as "immediate" | "delay" | "never", markReadDelaySeconds: 2 },
  setDefaultAccountId: vi.fn(),
  setTimeFormat: vi.fn(),
  setMarkReadMode: vi.fn(),
  setMarkReadDelaySeconds: vi.fn(),
  setContentSecurity: vi.fn(),
}));
```

Replace the `vi.mock("../../ipc/queries", ...)` block with:

```tsx
vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({
    data: [
      { id: 3, email: "a@example.com", display_name: "A", provider_type: "imap_password", color: null, position: 0, requires_reauth: false },
      { id: 5, email: "b@example.com", display_name: "B", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
    ],
  }),
  useContentSecurityLevel: () => ({ data: "balanced" }),
  useSetContentSecurityLevel: () => ({ mutate: setContentSecurity }),
}));
```

Add a new test inside `describe("GeneralSection", ...)`:

```tsx
it("persists a chosen email content security level", () => {
  const { getByLabelText } = render(<GeneralSection />);
  fireEvent.change(getByLabelText("Email content security"), { target: { value: "strict" } });
  expect(setContentSecurity).toHaveBeenCalledWith("strict");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/settings/GeneralSection.test.tsx`
Expected: FAIL — no element labeled "Email content security".

- [ ] **Step 4: Implement the control in `src/features/settings/GeneralSection.tsx`**

Update the imports:

```tsx
import { useAccounts, useContentSecurityLevel, useSetContentSecurityLevel } from "../../ipc/queries";
import {
  CONTENT_SECURITY_LEVELS,
  DEFAULT_CONTENT_SECURITY_LEVEL,
  type ContentSecurityLevel,
} from "../../shared/contentSecurity";
```

Inside the component, after `const { data: accounts = [] } = useAccounts();`, add:

```tsx
  const { data: contentSecurity = DEFAULT_CONTENT_SECURITY_LEVEL } = useContentSecurityLevel();
  const setContentSecurity = useSetContentSecurityLevel();
  const activeContentSecurity = CONTENT_SECURITY_LEVELS.find((l) => l.value === contentSecurity);
```

Add this `settings-field` block immediately after the Default account `settings-field` (before the Time format label):

```tsx
      <div className="settings-field">
        <div className="settings-field__label">Email content security</div>
        <select
          className="settings-select"
          aria-label="Email content security"
          value={contentSecurity}
          onChange={(e) => setContentSecurity.mutate(e.target.value as ContentSecurityLevel)}
        >
          {CONTENT_SECURITY_LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        {activeContentSecurity && (
          <div className="settings-field__hint">{activeContentSecurity.description}</div>
        )}
      </div>
```

- [ ] **Step 5: Add the hint CSS to `src/features/settings/Settings.css`**

After the `.settings-field__label { ... }` rule (~line 106), add:

```css
.settings-field__hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/features/settings/GeneralSection.test.tsx`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 7: Commit**

```bash
git add src/ipc/queries.ts src/features/settings/GeneralSection.tsx src/features/settings/Settings.css src/features/settings/GeneralSection.test.tsx
git commit -m "feat(settings): expose email content security level in General"
```

---

### Task 4: Apply the level in the reader

**Files:**
- Modify: `src/features/reader/MessageBodyView.tsx`
- Test: `src/features/reader/MessageBodyView.test.tsx`

**Interfaces:**
- Consumes: `useContentSecurityLevel` (Task 3); `sandboxForLevel`, `interceptLinksForLevel`, `autoloadRemoteForLevel`, `DEFAULT_CONTENT_SECURITY_LEVEL` (Task 1); `SafeHtmlFrame` props (Task 2).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Update the failing test**

Replace `src/features/reader/MessageBodyView.test.tsx` with:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getMessageBody: vi.fn().mockResolvedValue({
      status: "ok",
      data: { message_id: 42, text_plain: null, text_html: "<p>hi</p>" },
    }),
    renderMessageHtml: vi.fn().mockResolvedValue({
      status: "ok",
      data: { html: "<p>safe</p>", blocked_remote_content: false, remote_loaded: false },
    }),
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    openExternalUrl: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

import { MessageBodyView } from "./MessageBodyView";
import { commands } from "../../ipc/bindings";

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>;
}

describe("MessageBodyView — HTML body path", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uses a fully locked iframe at the strict level", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "strict"]],
    });
    render(<MessageBodyView messageId={42} />, { wrapper: Wrapper });

    await waitFor(() => {
      const el = screen.getByTitle("message-content");
      expect(el.getAttribute("sandbox")).toBe("");
    });
  });

  it("relaxes the iframe to same-origin (never scripts) at the balanced level", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "balanced"]],
    });
    render(<MessageBodyView messageId={42} />, { wrapper: Wrapper });

    await waitFor(() => {
      const el = screen.getByTitle("message-content");
      expect(el.getAttribute("sandbox")).toBe("allow-same-origin");
    });
    expect(screen.getByTitle("message-content").getAttribute("sandbox")).not.toContain("allow-scripts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/reader/MessageBodyView.test.tsx`
Expected: FAIL — the balanced test sees `sandbox=""` (the view does not yet read the level).

- [ ] **Step 3: Implement the wiring in `src/features/reader/MessageBodyView.tsx`**

Update the imports at the top:

```tsx
import { useState, useEffect } from "react";
import { useRenderedMessage, useMessageBody, useContentSecurityLevel } from "../../ipc/queries";
import { SafeHtmlFrame } from "./SafeHtmlFrame";
import {
  sandboxForLevel,
  interceptLinksForLevel,
  autoloadRemoteForLevel,
  DEFAULT_CONTENT_SECURITY_LEVEL,
} from "../../shared/contentSecurity";
```

Replace the body of `MessageBodyView` (the `forceLoadRemote` state + reset effect + the HTML branch) so it reads the level:

```tsx
export function MessageBodyView({ messageId }: { messageId: number }) {
  const { data: level = DEFAULT_CONTENT_SECURITY_LEVEL } = useContentSecurityLevel();
  const [forceLoadRemote, setForceLoadRemote] = useState(autoloadRemoteForLevel(level));
  const { data: rendered, isLoading: renderLoading } = useRenderedMessage(messageId, forceLoadRemote);
  const { data: body, isLoading: bodyLoading } = useMessageBody(messageId);

  useEffect(() => {
    setForceLoadRemote(autoloadRemoteForLevel(level));
  }, [messageId, level]);

  if (renderLoading && rendered == null) {
    return <p className="loading-state">Loading…</p>;
  }

  if (rendered?.html != null) {
    return (
      <div className="message-body">
        {rendered.blocked_remote_content && <RemoteContentBanner onLoad={() => setForceLoadRemote(true)} />}
        <SafeHtmlFrame
          html={rendered.html}
          sandbox={sandboxForLevel(level)}
          interceptLinks={interceptLinksForLevel(level)}
        />
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

(Leave the `RemoteContentBanner` component above unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/reader/MessageBodyView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/MessageBodyView.tsx src/features/reader/MessageBodyView.test.tsx
git commit -m "feat(reader): apply content security level to message body rendering"
```

---

### Task 5: Per-account image toggle override + Open-level lock

**Files:**
- Modify: `src/features/settings/AccountsSection.tsx` (`AccountImageToggle`, ~lines 170-194; add import)
- Test: `src/features/settings/AccountsSection.test.tsx`

**Interfaces:**
- Consumes: `useContentSecurityLevel` (Task 3); `DEFAULT_CONTENT_SECURITY_LEVEL` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Edit `src/features/settings/AccountsSection.test.tsx`. Ensure `screen` is imported:

```tsx
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
```

Add this test inside the existing `describe(...)` block:

```tsx
it("locks the per-account image toggle at the Open security level", async () => {
  (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: "ok",
    data: [["reader.contentSecurity", "open"]],
  });
  wrap();

  const toggle = await screen.findByLabelText("Always load remote images for jan@firma.pl");
  await waitFor(() => expect(toggle).toBeDisabled());
  expect(screen.getAllByText(/loaded for all accounts by the global Open level/i).length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/AccountsSection.test.tsx`
Expected: FAIL — toggle is not disabled and the hint text is absent.

- [ ] **Step 3: Implement in `src/features/settings/AccountsSection.tsx`**

Add `useContentSecurityLevel` to the existing `../../ipc/queries` import, and add:

```tsx
import { DEFAULT_CONTENT_SECURITY_LEVEL } from "../../shared/contentSecurity";
```

Replace the `AccountImageToggle` function with:

```tsx
function AccountImageToggle({ accountId, email }: { accountId: number; email: string }) {
  const { data: autoload = false } = useImageAutoload(accountId);
  const setAutoload = useSetImageAutoload();
  const { data: level = DEFAULT_CONTENT_SECURITY_LEVEL } = useContentSecurityLevel();
  const lockedOpen = level === "open";
  const on = lockedOpen || autoload;

  return (
    <div className={`appearance-toggle accounts-settings__images${lockedOpen ? " appearance-toggle--disabled" : ""}`}>
      <div className="appearance-toggle__text">
        <div className="appearance-toggle__label">Always load remote images</div>
        <div className="appearance-toggle__hint">
          {lockedOpen
            ? "Remote images are loaded for all accounts by the global Open level"
            : "Overrides the global content security level — always loads remote images for this account"}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Always load remote images for ${email}`}
        disabled={lockedOpen}
        className={`switch${on ? " switch--on" : ""}`}
        onClick={() => {
          if (!lockedOpen) setAutoload.mutate({ accountId, value: !autoload });
        }}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/settings/AccountsSection.test.tsx`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/AccountsSection.tsx src/features/settings/AccountsSection.test.tsx
git commit -m "feat(settings): frame per-account image toggle as override and lock it at Open level"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole frontend test suite**

Run: `npx vitest run`
Expected: PASS — all suites green, including the existing Composer/MeetingInviteCard suites that touch `SafeHtmlFrame`/`openExternalUrl`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit (only if Steps 1-2 required any fixes)**

```bash
git add -A
git commit -m "test(reader): stabilize content security level suite"
```

---

## Self-Review

**Spec coverage:**
- Three levels + default Balanced → Task 1 (`CONTENT_SECURITY_LEVELS`, `DEFAULT_CONTENT_SECURITY_LEVEL`) + Task 3 UI + Task 4 application. ✓
- Security invariant (never allow-scripts) → Task 1 test + Task 2 test. ✓
- Sandbox mapping (strict `""`, balanced/open `allow-same-origin`) → Task 1 + Task 4 tests. ✓
- Link interception via `open_external_url` (https/tel) → Task 2. ✓
- SafeHtmlFrame safe-by-default (signature previews unchanged) → Task 2 defaults + existing Composer tests verified in Task 6. ✓
- Remote-image baseline: Open auto-loads via `forceLoadRemote` initial + reset effect → Task 4. ✓
- Settings placement in General → Task 3. ✓
- Per-account toggle reworded as override + disabled at Open with hint → Task 5. ✓
- Persistence key `reader.contentSecurity` via settings table → Task 3. ✓
- No Rust changes → confirmed (reuses `open_external_url` + `render_message_html`'s existing `force_load_remote`). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `ContentSecurityLevel`, `sandboxForLevel`, `interceptLinksForLevel`, `autoloadRemoteForLevel`, `isExternalLink`, `parseContentSecurityLevel`, `useContentSecurityLevel`, `useSetContentSecurityLevel` used identically across Tasks 1-5. Setting key string `reader.contentSecurity` identical in queries hook and all test mocks. ✓
