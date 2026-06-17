# AbeonMail Etap 2B (Frontend: usable inbox UI) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Zbudować frontend Etapu 2: warstwę danych (@tanstack/query nad komendami + eventy), kreator dodawania konta IMAP, listę folderów (szyna), wirtualizowaną listę wiadomości i reader renderujący bezpiecznie treść maila (sandbox iframe + blok zdalnych obrazów) — tak, by realnie „przeczytać swój Inbox".

**Architecture:** React czyta backend wyłącznie przez wygenerowane, typowane bindings (`src/ipc/bindings.ts`) opakowane w hooki @tanstack/query. Treść maila pobierana on-demand i sanityzowana po stronie Rust (komenda `sanitizeMessageHtml`), renderowana w `<iframe sandbox>` bez skryptów. Stan UI (zaznaczone konto/folder/wiadomość) w lekkim store (zustand).

**Tech Stack:** React 19, TypeScript, @tanstack/react-query, @tanstack/react-virtual, zustand, vitest + happy-dom + @testing-library/react. Node ≥ 24.

## Global Constraints

- English identifiers; NO comments in code.
- Conventional Commits 1.0.0; NO Co-Authored-By; push only on request.
- Node ≥ 24 — for any npm/npx run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`.
- Frontend talks to backend ONLY through `src/ipc/` (the generated `commands`/`events`); never invoke raw.
- Mail HTML is UNTRUSTED: render ONLY sanitized HTML (via `commands.sanitizeMessageHtml`) inside an `<iframe sandbox>` WITHOUT `allow-scripts` and WITHOUT `allow-same-origin`. Never use `dangerouslySetInnerHTML` for mail content.
- Generated bindings use snake_case fields (`display_name`, `provider_type`, `imap_host`, `text_html`, `blocked_remote_content`, …) — consume them as generated; do not rename.
- Use the design tokens from `src/shared/theme/tokens.css` (indigo accent, lavender neutrals, dark surfaces). Keep light/dark working. Build on the existing `AppShell`/rail/panes from Etap 1.
- Tests: vitest + happy-dom, mock `../ipc/...` (and `@tanstack/react-query` where needed) — no real Tauri runtime. Pristine output. Headless env: DO NOT run `tauri dev`; verify via vitest + `npm run build`.

## File Structure

- `src/ipc/queries.ts` — typed @tanstack/query hooks over `commands` (accounts/folders/messages/body) + `addAccount`/`resolveEndpoints` mutations.
- `src/ipc/events.ts` — subscribe to `events.syncProgress`/`events.newMessages`, invalidate queries.
- `src/app/store.ts` — zustand store: `selectedAccountId`, `selectedFolderId`, `selectedMessageId`, `density`.
- `src/app/QueryProvider.tsx` — QueryClient provider.
- `src/features/accounts/AddAccountWizard.tsx` — email/password → endpoints (editable) → add.
- `src/features/mailbox/MailboxRail.tsx` — extend Etap-1 rail: real accounts + folders + smart folders + "Add account".
- `src/features/message-list/MessageListPane.tsx` — virtualized list bound to selected folder.
- `src/features/reader/ReaderPane.tsx` — fetch body, sanitize, render in sandboxed iframe + remote-content banner.
- `src/features/reader/SafeHtmlFrame.tsx` — the sandboxed iframe component.
- Tests colocated as `*.test.tsx`.

---

## Task 1: Data layer — QueryProvider, query/mutation hooks, event wiring, UI store

**Files:**
- Create: `src/app/QueryProvider.tsx`, `src/app/store.ts`, `src/ipc/queries.ts`, `src/ipc/events.ts`
- Modify: `src/main.tsx` (wrap app in `QueryProvider`), `package.json` (deps)
- Test: `src/ipc/queries.test.tsx`

**Interfaces:**
- Consumes: `commands` + `events` + types from `src/ipc/bindings.ts`.
- Produces:
  - Hooks (using `@tanstack/react-query`): `useAccounts()`, `useFolders(accountId: number | null)`, `useMessages(folderId: number | null)`, `useMessageBody(messageId: number | null)`, `useResolveEndpoints()` (returns a function/mutation), `useAddAccount()` (mutation).
  - `src/ipc/events.ts`: `useSyncEvents()` hook that, on mount, subscribes to `events.syncProgress` and `events.newMessages` and invalidates the relevant query keys; unsub on unmount.
  - `src/app/store.ts`: `useUiStore` (zustand) with `selectedAccountId`, `selectedFolderId`, `selectedMessageId`, `density: "comfortable"|"cozy"|"compact"|"dense"` and setters.
  - Query keys are stable arrays, e.g. `["accounts"]`, `["folders", accountId]`, `["messages", folderId]`, `["body", messageId]`.

- [ ] **Step 1: Install deps**

With Node 24 on PATH: `npm install @tanstack/react-query @tanstack/react-virtual zustand`. Confirm they land in `package.json` dependencies.

- [ ] **Step 2: Write failing test for `useAccounts`**

`src/ipc/queries.test.tsx`: mock `./bindings` so `commands.listAccounts` resolves to a fixed array; render a component using `useAccounts()` inside a `QueryClientProvider` with a fresh `QueryClient`; assert the data appears (via `waitFor`). This drives the hook shape.

Run (Node 24): `npx vitest run src/ipc/queries.test.tsx` → FAIL (hook missing).

- [ ] **Step 3: Implement QueryProvider, store, hooks, events**

`QueryProvider.tsx`: a `QueryClient` (sensible defaults: `staleTime` ~30s, no refetch-on-window-focus for a desktop app) wrapped in `QueryClientProvider`.
`store.ts`: zustand store as specified.
`queries.ts`: implement each hook with `useQuery`/`useMutation` calling the matching `commands.*`. `useFolders`/`useMessages`/`useMessageBody` are `enabled` only when their id is non-null. `useAddAccount` mutation calls `commands.addAccount` and on success invalidates `["accounts"]` (and `["folders", newAccountId]`). `useResolveEndpoints` wraps `commands.resolveEndpoints`.
`events.ts`: `useSyncEvents()` uses the generated `events.syncProgress.listen(...)`/`events.newMessages.listen(...)` (adapt to the generated API shape) and on each event calls `queryClient.invalidateQueries` for `["folders", accountId]` / `["messages", folderId]`. Returns nothing; cleanup unsubscribes.

- [ ] **Step 4: Run test — GREEN**

Run: `npx vitest run src/ipc/queries.test.tsx` → PASS. Also run full `npx vitest run` (existing tests still pass).

- [ ] **Step 5: Wire QueryProvider in main.tsx + Commit**

Wrap `<App/>` with `<QueryProvider>` (inside `<ThemeProvider>`). Run `npm run build` (clean).

```bash
git add src/ipc src/app/QueryProvider.tsx src/app/store.ts src/main.tsx package.json package-lock.json
git commit -m "feat(ui): add react-query data layer, ui store, and sync event wiring"
```

---

## Task 2: Add-account wizard

**Files:**
- Create: `src/features/accounts/AddAccountWizard.tsx`
- Test: `src/features/accounts/AddAccountWizard.test.tsx`

**Interfaces:**
- Consumes: `useResolveEndpoints`, `useAddAccount`, design tokens.
- Produces: `AddAccountWizard({ onClose, onAdded }: { onClose: () => void; onAdded: (accountId: number) => void })` — a modal/panel that: (1) takes email + display name + password; (2) on email blur or "Continue", calls resolveEndpoints and shows the editable IMAP/SMTP host/port/TLS fields prefilled; (3) on "Add account", calls the addAccount mutation; (4) shows loading + error states (generic error string from backend); (5) on success calls `onAdded(account.id)`.

- [ ] **Step 1: Write failing test**

`AddAccountWizard.test.tsx` (happy-dom + @testing-library): mock `../../ipc/queries` so `useResolveEndpoints` returns a resolver yielding fixed endpoints and `useAddAccount` returns a mutation that resolves to `{ id: 7, email: ... }`. Render the wizard; type an email/password; trigger resolve; assert prefilled imap host appears; click "Add account"; assert `onAdded` called with 7 (via `waitFor`). Add a test where the add mutation rejects → assert a generic error message is shown.

Run (Node 24): `npx vitest run src/features/accounts/AddAccountWizard.test.tsx` → FAIL.

- [ ] **Step 2: Implement the wizard**

Build the form with controlled inputs and the two-step flow (credentials → endpoints confirm). Use tokens for styling (accent button, surface bg). The password input is `type="password"`. Show a spinner during the add (initial sync runs server-side — the mutation may take seconds). On error show the backend's generic string. Keep it a focused component (< ~200 lines); if larger, split the endpoints form into a subcomponent.

- [ ] **Step 3: GREEN + build + Commit**

Run: `npx vitest run src/features/accounts/AddAccountWizard.test.tsx` → PASS; `npm run build` clean.

```bash
git add src/features/accounts
git commit -m "feat(ui): add imap account creation wizard"
```

---

## Task 3: Mailbox rail with real accounts + folders

**Files:**
- Modify: `src/features/mailbox/MailboxRail.tsx`
- Test: `src/features/mailbox/MailboxRail.test.tsx`

**Interfaces:**
- Consumes: `useAccounts`, `useFolders`, `useUiStore`, `AddAccountWizard`.
- Produces: rail showing each account (name/email + color dot) and its folders (from `useFolders`), with click handlers that set `selectedAccountId`/`selectedFolderId` in the store; a smart-folders section (All Inboxes / Unread / Flagged — static labels for now, selecting "All Inboxes"/Inbox sets selection); an "Add account" button that opens `AddAccountWizard`; an empty state ("No accounts — add one") when `useAccounts` is empty. Preserve the existing `IPC: ok` status line from Etap 1 (move it to a footer) — optional.

- [ ] **Step 1: Write failing test**

`MailboxRail.test.tsx`: mock `../../ipc/queries` so `useAccounts` returns `[{id:1, email:"a@x.com", display_name:"A", ...}]` and `useFolders(1)` returns `[{id:10, name:"Inbox", folder_type:"inbox", ...}]`. Mock the store. Render; assert account name + "Inbox" appear; click Inbox → assert `setSelectedFolderId(10)` called. Assert empty-state renders when accounts is `[]`.

Run: FAIL.

- [ ] **Step 2: Implement the rail**

Render accounts + folders from the hooks; wire selection to the store; render `AddAccountWizard` in a modal when "Add account" is clicked (local `useState` for open). Empty state. Style with tokens; mark folder/account rows with the existing `.rail` styling, add active state using `--accent`.

- [ ] **Step 3: GREEN + build + Commit**

Run tests + `npm run build`. Commit `feat(ui): wire mailbox rail to real accounts and folders`.

---

## Task 4: Virtualized message list

**Files:**
- Modify: `src/features/message-list/MessageListPane.tsx`
- Test: `src/features/message-list/MessageListPane.test.tsx`

**Interfaces:**
- Consumes: `useMessages(selectedFolderId)`, `useUiStore` (selectedFolderId, selectedMessageId, density), `@tanstack/react-virtual`.
- Produces: a virtualized list of `MessageHeader` rows (sender name/address, subject, date, unread/flagged indicator) bound to the selected folder; clicking a row sets `selectedMessageId`; density affects row height; empty state when no folder selected or folder empty; loading skeleton while fetching.

- [ ] **Step 1: Write failing test**

`MessageListPane.test.tsx`: mock `useMessages` to return ~5 headers; mock store with a selected folder. Render; assert at least the first subject is visible; click a row → assert `setSelectedMessageId` called with the right id. Assert empty-state when `selectedFolderId` is null. (Virtualization renders a subset — assert on the first visible item, and set a container height in the test so the virtualizer mounts rows; if happy-dom lacks layout, fall back to asserting the list container + that the rows callback ran — adapt so the test verifies real behavior, not a no-op.)

Run: FAIL.

- [ ] **Step 2: Implement the list**

Use `useVirtualizer` from `@tanstack/react-virtual` with a scroll container ref and `estimateSize` per density. Render each row with sender/subject/date and unread/flagged styling. Format the date (epoch seconds → locale short). Wire row click to the store. Handle empty/loading. Keep the component focused.

- [ ] **Step 3: GREEN + build + Commit**

Tests + build. Commit `feat(ui): add virtualized message list bound to selected folder`.

---

## Task 5: Reader with safe HTML rendering

**Files:**
- Create: `src/features/reader/SafeHtmlFrame.tsx`
- Modify: `src/features/reader/ReaderPane.tsx`
- Test: `src/features/reader/SafeHtmlFrame.test.tsx`, `src/features/reader/ReaderPane.test.tsx`

**Interfaces:**
- Consumes: `useMessageBody(selectedMessageId)`, `commands.sanitizeMessageHtml`, `useUiStore`.
- Produces:
  - `SafeHtmlFrame({ html }: { html: string })` — renders the given (already-sanitized) HTML inside an `<iframe>` using `srcDoc={html}` and `sandbox=""` (NO `allow-scripts`, NO `allow-same-origin`). Sets a title for a11y. The iframe is the ONLY place mail HTML is rendered.
  - `ReaderPane()` — when a message is selected: fetch body via `useMessageBody`; if `text_html` present, call `commands.sanitizeMessageHtml(text_html)` → `{ html, blocked_remote_content }`, render `html` via `SafeHtmlFrame`; show a "Remote content blocked — Load images" banner when `blocked_remote_content` is true (clicking it is a no-op placeholder for now OR re-renders without blocking — keep a documented stub: the load-remote action is wired in a later etap; the banner must at least appear). If only `text_plain`, render it as escaped preformatted text (NOT via the iframe HTML path). Empty state when no message selected; loading state while fetching.

- [ ] **Step 1: Write failing tests**

`SafeHtmlFrame.test.tsx`: render `<SafeHtmlFrame html="<p>hi</p>" />`; query the iframe; assert it has a `sandbox` attribute that does NOT contain `allow-scripts` and does NOT contain `allow-same-origin`, and that `srcDoc`/`srcdoc` contains the html. (This is the security regression test — it must assert the sandbox is locked down.)
`ReaderPane.test.tsx`: mock `useMessageBody` to return `{ text_html: "<p>x</p>", text_plain: null }` and mock `commands.sanitizeMessageHtml` to resolve `{ html: "<p>x</p>", blocked_remote_content: true }`; mock store with a selected message; render; assert the iframe appears and the "Load images"/remote-blocked banner is shown. Add a case with `blocked_remote_content:false` → no banner. Add a plain-text-only case → text shown, NO iframe.

Run: FAIL.

- [ ] **Step 2: Implement SafeHtmlFrame + ReaderPane**

`SafeHtmlFrame`: `<iframe title="message-content" sandbox="" srcDoc={html} className="reader-frame" />`. (Empty `sandbox=""` applies all restrictions.)
`ReaderPane`: orchestrate fetch → sanitize (use a `useQuery`/`useEffect` or a small `useQuery(["sanitized", messageId], () => commands.sanitizeMessageHtml(html))` keyed on the body) → render. Banner component when blocked. Plain-text path renders inside a `<pre>`/escaped block, not the iframe. Styling via tokens.

- [ ] **Step 3: GREEN + build + Commit**

Run both test files + full `npx vitest run` + `npm run build` (clean). Commit `feat(ui): add reader with sandboxed html rendering and remote-content banner`.

---

## Self-Review

**Spec coverage (Etap 2 frontend portion):**
- Data layer + event-driven invalidation → Task 1.
- Account-add wizard (email+password → autodiscovery editable → add) → Task 2.
- Folder list rail + smart folders + add-account entry + empty state → Task 3.
- Virtualized message list bound to folder → Task 4.
- Reader: on-demand body + sanitized HTML in sandboxed iframe + remote-image-blocked banner + plain-text fallback → Task 5.

**Security:** all mail HTML is rendered ONLY via `SafeHtmlFrame` (sandbox without allow-scripts/allow-same-origin), on already-sanitized output of `commands.sanitizeMessageHtml`; never `dangerouslySetInnerHTML` for mail. Task 5 Step 1 asserts the sandbox lockdown as a regression test.

**Placeholder scan:** The "Load images" action is a documented stub (banner appears; the actual reload-with-remote-content is a later-etap feature) — this is an intentional, stated scope boundary, not an unfilled gap.

**Type consistency:** hooks return the generated binding types (snake_case fields); the store ids are `number | null`; query keys are consistent across Task 1 (definitions) and Tasks 3/4/5 (usage).

**Deferred to later etaps:** incremental sync/IDLE, multi-folder sync, compose/send, search, labels, snooze, settings, the actual load-remote-images action, RFC2047 subject decoding (tracked from 2A review), emitting real sync progress events from the backend (2A left them declared-but-unemitted — Task 1 subscribes; backend emission is a later wiring task).

## Notes

- Headless environment: components verified via vitest + happy-dom + mocked IPC; `npm run build` (tsc+vite) must pass. The full app is not launched (`tauri dev` needs a display).
- Backend currently does not emit `syncProgress`/`newMessages` (declared in 2A, emission deferred). `useSyncEvents` subscribing is harmless; invalidation simply won't fire until the backend emits. Manual refetch after `addAccount` (mutation invalidation) covers the initial-load case.
