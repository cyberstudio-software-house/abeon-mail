# Email content security level — design

Date: 2026-06-22
Status: approved (pending implementation plan)

## Problem

Clicking a link in an email body does nothing. The body is rendered in a fully
locked iframe (`SafeHtmlFrame`, `sandbox=""`). The server-side sanitizer
(`crates/am-mime/src/sanitize.rs`) sets `target="_blank"` + `rel="noopener
noreferrer"` on every anchor, but an empty sandbox blocks the popup/new-window
needed to honor `target="_blank"`, so the click is silently dropped. Scripts and
`on*` handlers are stripped by ammonia, so no in-iframe handler can be injected,
and with an opaque origin the parent cannot reach into the iframe DOM either.

Separately, remote images are blocked by default; a per-account
`images.autoload.{accountId}` toggle exists (Settings → Accounts) but is not very
discoverable. Some users find the strict defaults inconvenient.

The user wants the security posture to be **configurable** so each user chooses
how locked-down email content rendering is.

## Goal

A single global **Email content security** level with three tiers, controlling
the email-body iframe isolation (and therefore whether external links open) plus
the remote-image baseline. The existing per-account image toggle remains as a
per-account override.

## Non-goals (YAGNI)

- No per-message or per-sender level.
- No `mailto:` → composer handling (possible future follow-up).
- No Rust/webview navigation handler (approach A is pure frontend).
- No tri-state per-account image control.

## Security invariants (must hold at every level)

1. **`allow-scripts` is NEVER set** on the email-body iframe at any level. Email
   JavaScript must never execute. Enforced by the pure `sandboxForLevel` mapping
   and asserted by a test that iterates all levels.
2. `allow-same-origin` appears only at Balanced/Open — i.e. only when the user
   has explicitly opted into a lower security level. Because scripts are still
   off, same-origin grants the email content no executable capability; it only
   lets the trusted parent read the iframe DOM to intercept link clicks.
3. External link opening reuses the existing backend `open_external_url`
   allowlist (`https://` and `tel:` only).
4. `SafeHtmlFrame` stays **safe by default**: its default props remain
   `sandbox=""` and no link interception. Signature previews (composer, settings)
   keep the current fully-locked behavior unchanged.

## Levels

| Level | iframe `sandbox` | External links | Remote images (baseline) |
|---|---|---|---|
| **Strict** | `""` (opaque, current) | disabled | blocked (per-account override possible) |
| **Balanced** (default) | `allow-same-origin` (scripts off) | open in system browser | blocked (per-account override possible) |
| **Open** | `allow-same-origin` (scripts off) | open in system browser | loaded for all accounts |

Default level: **Balanced**. Absent setting ⇒ Balanced. This means existing
users' email links start working after upgrade — an intended behavior change.

## Remote-image interaction (level × per-account toggle)

Effective remote-image loading is the OR of three sources:

```
load_remote = autoloadRemoteForLevel(level) || perAccountAutoload || bannerLoadImages
```

| Global level | Per-account autoload | Result |
|---|---|---|
| Strict | off | blocked (banner offered) |
| Strict | on | loaded (per-account override) |
| Balanced | off | blocked (banner offered) |
| Balanced | on | loaded (per-account override) |
| Open | off | loaded (level forces) |
| Open | on | loaded |

Roles, framed to avoid contradiction:

- **Global level** = baseline image policy (Strict/Balanced: block by default;
  Open: load everywhere) plus the sandbox/link behavior.
- **Per-account toggle** = explicit "always load remote images for this account",
  overriding the baseline. Meaningful at Strict/Balanced; redundant at Open.

Complete model:

- Images everywhere → **Open**.
- Images only for chosen accounts → **Balanced** + per-account ON for those.
- Maximum lockdown → **Strict** (optionally per-account ON for one trusted account).

At the **Open** level the per-account toggle is **disabled with a hint**
("Remote images are loaded for all accounts by the global Open level") so it does
not appear to do nothing.

## Architecture & components

### 1. `src/shared/contentSecurity.ts` (new) — single source of truth

Pure module, no React/IPC deps (pattern mirrors `src/shared/smartFolders.ts`).

- `type ContentSecurityLevel = "strict" | "balanced" | "open"`
- `DEFAULT_CONTENT_SECURITY_LEVEL: ContentSecurityLevel = "balanced"`
- `CONTENT_SECURITY_LEVELS: { value: ContentSecurityLevel; label: string; description: string }[]`
  — drives the settings `<select>` and its option descriptions.
- `sandboxForLevel(level): string` → `""` for strict, `"allow-same-origin"` for
  balanced/open. **Never returns a string containing `allow-scripts`.**
- `interceptLinksForLevel(level): boolean` → `false` for strict, else `true`.
- `autoloadRemoteForLevel(level): boolean` → `true` only for open.
- `isExternalLink(href: string): boolean` → true for `https://` / `tel:`
  (case-insensitive), mirroring the backend allowlist.
- `parseContentSecurityLevel(value: string | undefined): ContentSecurityLevel`
  → validates a stored string, falling back to the default.

### 2. `src/ipc/queries.ts` — persistence hooks

Setting key: `reader.contentSecurity`. Stored via the existing settings table
(`get_settings` / `set_setting`), pattern identical to `useImageAutoload` /
`useSetImageAutoload`.

- `useContentSecurityLevel()` → reads the key, returns a parsed
  `ContentSecurityLevel` (default Balanced when absent). Query key
  `["content-security-level"]`.
- `useSetContentSecurityLevel()` → writes the key, invalidates the query.

### 3. `src/features/reader/SafeHtmlFrame.tsx` — opt-in relaxation

New optional props, defaults preserve current behavior:

- `sandbox?: string` (default `""`)
- `interceptLinks?: boolean` (default `false`)

When `interceptLinks` is true, a `useEffect` + `ref` attaches a `click` listener
to the iframe's `contentDocument` (on `load` and immediately, deduped):

- find `closest("a[href]")` from the event target;
- if `isExternalLink(href)`: `event.preventDefault()` and
  `commands.openExternalUrl(href)`;
- otherwise ignore (default action, blocked by sandbox as before).

Null-safe: if `contentDocument` is inaccessible (cross-origin/null), it simply
does not attach — links degrade to "do nothing" (Strict-like) with no crash.
Listener is re-attached when `html` changes and cleaned up on unmount.

### 4. `src/features/reader/MessageBodyView.tsx` — the only consumer of the level

- Read the level via `useContentSecurityLevel()`.
- Initialize `forceLoadRemote` state to `autoloadRemoteForLevel(level)` (Open ⇒
  remote images load on first render; reuses existing `render_message_html`
  plumbing — **no Rust change**). The existing reset effect changes from
  hardcoded `false` to `autoloadRemoteForLevel(level)` and reacts to both
  `messageId` and `level` (so switching to Open re-renders the open message with
  remote images). The "Load images" banner keeps working for Strict/Balanced.
- Pass `sandbox={sandboxForLevel(level)}` and
  `interceptLinks={interceptLinksForLevel(level)}` to `SafeHtmlFrame`.

### 5. `src/features/settings/GeneralSection.tsx` — the control

Add an "Email content security" field: a `<select>` over
`CONTENT_SECURITY_LEVELS` bound to `useContentSecurityLevel()` /
`useSetContentSecurityLevel()`, with the selected level's description shown
beneath (English UI copy, consistent with existing sections).

### 6. `src/features/settings/AccountsSection.tsx` — clarity + Open handling

- Reword the per-account image toggle label/description to state it overrides the
  global level (e.g. "Always load remote images for this account — overrides the
  global content-security level").
- When `useContentSecurityLevel()` is `open`, render the toggle `disabled` with
  the hint "Remote images are loaded for all accounts by the global Open level".

## Data flow

```
GeneralSection ──set/read──► settings table (reader.contentSecurity)
                                   │
                       useContentSecurityLevel()
                                   │
                 ┌─────────────────┴───────────────────┐
                 ▼                                       ▼
        MessageBodyView                          AccountsSection
   sandbox / interceptLinks /                 (disable+hint at Open)
   initial forceLoadRemote
                 │
                 ▼
          SafeHtmlFrame ──click on <a>──► isExternalLink? ──► commands.openExternalUrl
```

## Testing

- **`src/shared/contentSecurity.test.ts`** (new):
  - invariant: for every level, `sandboxForLevel(level)` does NOT contain
    `allow-scripts`;
  - mapping correctness for `sandboxForLevel`, `interceptLinksForLevel`,
    `autoloadRemoteForLevel`;
  - `isExternalLink` accepts https/tel (any case), rejects http/mailto/javascript/
    relative;
  - `parseContentSecurityLevel` validation + default fallback.
- **`src/features/reader/SafeHtmlFrame.test.tsx`**:
  - keep existing SECURITY tests for default props (`sandbox=""`, no
    `allow-scripts`, no `allow-same-origin`);
  - with `sandbox="allow-same-origin"` + `interceptLinks`: clicking an `https`
    anchor calls `openExternalUrl` and prevents default; a `javascript:`/`http:`
    anchor does not;
  - with `interceptLinks={false}`: clicking does not call `openExternalUrl`.
  - (happy-dom populates srcDoc + dispatches iframe clicks — verified.)
- **`src/features/reader/MessageBodyView.test.tsx`**: mock
  `useContentSecurityLevel`; Strict ⇒ iframe `sandbox=""`; Balanced ⇒
  `allow-same-origin` and not `allow-scripts`. Update the existing
  `sandbox===""` assertion accordingly.
- **`src/features/settings/GeneralSection.test.tsx`**: changing the select calls
  `setSetting("reader.contentSecurity", ...)`.
- **`src/features/settings/AccountsSection.test.tsx`**: at Open level the
  per-account image toggle is disabled and the hint is shown.

## Migration

Setting absent ⇒ Balanced. No data migration. Existing users gain working email
links on first launch after upgrade (intended). Documented here so the behavior
change is traceable.

## Out-of-scope follow-ups (noted, not built)

- `mailto:` links opening the in-app composer.
- Per-account "never load" (force-block) override at the Open level.
