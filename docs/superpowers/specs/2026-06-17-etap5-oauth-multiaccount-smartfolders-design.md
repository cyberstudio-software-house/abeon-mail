# Etap 5 — Google OAuth + multi-account + smart folders — Design

**Status:** approved (brainstorm)
**Builds on:** Etap 4 (multi-account IMAP/SMTP password-only, send pipeline, composer, drafts, threading).

## Goal

Add Google OAuth (PKCE + XOAUTH2 with background token refresh), live cross-account
smart folders (All Inboxes / Unread / Flagged), and account management (remove,
re-auth on token expiry, reorder).

## Scope decisions

- **OAuth client_id:** registered by the user in Google Cloud Console, injected via
  configuration (env `ABEONMAIL_GOOGLE_CLIENT_ID` or config file). No client_secret
  (PKCE). Enables live E2E on the user's own Google account.
- **Smart folders:** All Inboxes, Unread, Flagged. Snoozed deferred to Etap 6; Drafts
  stays per-account (removed from the smart-folder rail).
- **Account management:** remove account, re-auth on OAuth expiry, reorder. Edit
  (name/color) deferred to Etap 7.
- **Token lifecycle (chosen approach A):** `OAuthTokenManager` in `am-auth` owns tokens;
  lazy just-in-time refresh with a 5-minute expiry buffer before each connection. No
  background refresh daemon; protocols stay credential-agnostic.

## Mandated by Google (not optional)

- System browser + loopback redirect `http://127.0.0.1:<port>`. Embedded webviews are
  blocked (`disallowed_useragent`).
- Scope `https://mail.google.com/ openid email`.

## Architecture and sub-plans

Three sub-plans, mirroring Etap 3/4 decomposition.

- **5A — OAuth core:** PKCE + loopback flow, XOAUTH2 in protocols, `OAuthTokenManager`,
  add-Google-account.
- **5B — Smart folders:** cross-account aggregate queries + UI.
- **5C — Account management:** remove, re-auth, reorder.

### Secret ownership (`am-auth`)

- Keychain stores **only the refresh token** (long-lived secret), under the existing
  `accounts.auth_ref`.
- **Access token + expiry live in memory only** (`OAuthTokenManager`,
  `Arc<Mutex<HashMap<auth_ref, CachedToken>>>`). After app restart the access token is
  re-derived by refreshing on first connect. Minimizes the persisted-secret surface.

### Crate boundaries (testability)

- `am-sync` / `am-protocols` know nothing about OAuth.
- `am-protocols` gains `enum ImapAuth { Password(String), XOauth2 { user: String,
  access_token: String } }` and an analogous `SmtpAuth`.
- `am-sync` obtains credentials before connecting through an injected trait (the token
  manager sits behind it), so tests supply a fake token without network access.

### Migration V5

- `ALTER TABLE accounts ADD COLUMN requires_reauth INTEGER NOT NULL DEFAULT 0;`
- Smart-folder indexes for cross-account scans: `idx_messages_seen_date ON
  messages(seen, date DESC)` and `idx_messages_flagged_date ON messages(flagged, date
  DESC)` (`idx_messages_account_seen` already exists but smart folders filter across
  accounts). Message ordering uses the `messages.date` column (epoch seconds).
- Remove-account relies on existing `ON DELETE CASCADE` (delete the `accounts` row +
  keychain secret + stop worker).

### New dependencies (`am-auth`)

- `oauth2` v5 (PKCE, code exchange, refresh — vetted library over hand-rolled crypto).
- `reqwest` (rustls + ring, consistent with the existing TLS stack) as HTTP backend for
  Google endpoints.
- `tokio-util` (5C) for `CancellationToken` worker shutdown.

## 5A — Google OAuth flow

### Google constants (`am-auth/src/oauth/google.rs`)

- auth `https://accounts.google.com/o/oauth2/v2/auth`, token
  `https://oauth2.googleapis.com/token`, userinfo
  `https://www.googleapis.com/oauth2/v3/userinfo`.
- scopes `https://mail.google.com/ openid email`.
- `client_id` from configuration; no client_secret.
- Gmail endpoints fixed: IMAP `imap.gmail.com:993` (TLS), SMTP `smtp.gmail.com:465`
  (implicit TLS). No autodiscovery for Google.

### Flow (`am-app` command `beginGoogleOauth()`, run in background)

1. `am-auth` generates `state` (CSRF) + PKCE verifier/challenge (S256).
2. `am-app` binds a loopback `TcpListener` on `127.0.0.1:0` → `redirect_uri =
   http://127.0.0.1:{port}`.
3. Open the system browser at the authorize URL (with
   `access_type=offline&prompt=consent` to always receive a refresh token).
4. Loopback accepts **one** request, **validates `state`** (mismatch → reject),
   extracts `code`, replies with a "you may close this tab" HTML page, closes the
   listener (timeout ~5 min).
5. `am-auth::exchange_code(code, verifier, redirect_uri)` → `{ access_token,
   refresh_token, expires_in }`.
6. Fetch the email address from **userinfo** (plain TLS call — no id_token signature
   verification needed; simpler and safe).
7. Store the refresh token in keychain under `auth_ref`; create the account row
   (`provider_type=google_oauth`, Gmail endpoints); seed the access token in
   `OAuthTokenManager`; spawn the worker.
8. Return `account_id` to the frontend.

### Token manager

`OAuthTokenManager::valid_access_token(auth_ref)` returns the cached token if > 5 min
remain; otherwise refreshes using the keychain refresh token and updates the cache.
`invalid_grant` (revoked consent) maps to a distinct `NeedsReauth` error (handled in 5C).

### XOAUTH2 in protocols

- IMAP: `ImapSession::connect(config, ImapAuth)`; for `XOauth2`, implement
  `async_imap::Authenticator` returning the SASL string `user=<email>\x01auth=Bearer
  <token>\x01\x01` (base64) via `client.authenticate("XOAUTH2", …)`.
- SMTP: `send_raw` takes `SmtpAuth`; for XOAUTH2 use lettre `Mechanism::Xoauth2` +
  `Credentials::new(email, access_token)`.

### Frontend

`AddAccountWizard` gains a **"Sign in with Google"** button calling
`beginGoogleOauth()`; on success the new account is selected. Password path unchanged.

### Tests (5A)

PKCE S256 (known vector), authorize URL building, code exchange and refresh against a
local mock HTTP server, expiry + 5-min buffer logic, XOAUTH2 SASL format, `invalid_grant
→ NeedsReauth` mapping, loopback capture (simulated redirect) + bad-`state` rejection.

## 5B — Smart folders

### Model

Three read-only cross-account aggregate views. **Flat list** (no cross-account
threading — threading is per-account), sorted `date DESC`, each row carries an account
badge (color + address). Drafts and deleted excluded (`draft = 0 AND deleted = 0`).

### Queries (`am-storage/src/smart_repo.rs`)

- **All Inboxes:** messages in folders `folder_type = 'inbox'` across all accounts.
- **Unread:** `seen = 0` across all accounts/folders, excluding Trash/Spam
  (`folder_type NOT IN ('trash','spam')`).
- **Flagged:** `flagged = 1` across all accounts, excluding Trash/Spam.
- All with `draft = 0 AND deleted = 0`, `LIMIT/OFFSET` pagination, backed by V5 indexes.
  They return the same list-row shape as `list_by_folder` plus `account_id`/color so the
  frontend reuses the list component.

### Command

`listSmartFolder(kind: SmartFolderKind, limit, offset)` where `kind` is `AllInboxes |
Unread | Flagged`. Opening a message and marking read/flag are unchanged — each row
carries `account_id` + `folder_id` + uid, so the existing `setMessageFlags` /
`markMessageSeen` apply per-message.

### Frontend (`MailboxRail.tsx`)

Remove `aria-disabled`/`opacity` from the three entries (Snoozed and Drafts leave the
rail). Selecting a smart folder sets a new `uiStore` selection state (`smartFolder`
instead of `account/folder`); `MessageList` switches on the source and calls
`listSmartFolder` instead of `listMessages`. Rows show an account color dot.

### Live update

Smart folders refresh through existing events (`newMessages`, `mailboxChanged`) — the
smart-folder query key invalidates on those events regardless of `account_id`.

### Tests (5B)

Queries on seeded multi-account data (date ordering, Trash/Spam + draft exclusion,
pagination); list render with account badges; selection switching smart-folder ↔ account
folder; invalidation on sync event.

## 5C — Account management

### Remove account (`removeAccount(account_id)`)

1. Signal stop to the worker and **join** it — the engine gains an `account_id →
   CancellationToken` registry (adds `tokio-util`); this also closes the existing
   "shutdown not interruptible mid-IDLE" tech-debt (the token cancels the IDLE wait too).
2. Delete the keychain secret (`delete_password(auth_ref)` — works for the refresh token
   too).
3. `DELETE FROM accounts WHERE id = ?` — `ON DELETE CASCADE` removes
   folders/messages/threads/queue/labels.
4. If the removed account was selected, the frontend clears the selection.

UI confirmation before removal (irreversible, deletes local data).

### Re-auth on OAuth expiry

When `OAuthTokenManager` returns `NeedsReauth` (e.g. `invalid_grant`), the worker sets
`accounts.requires_reauth = 1` and emits `accountAuthChanged`. The rail shows a
"⚠ Reconnect" marker on the account; clicking re-runs `beginGoogleOauth()` for the
existing account (same address) → overwrites the refresh token, `requires_reauth = 0`,
restarts the worker.

### Reorder (`reorderAccounts(ordered_ids: Vec<i64>)`)

Updates `accounts.position` in a transaction; rail with drag-and-drop. Accounts sort by
`position` (already in schema).

### Error handling

- Missing `client_id` in configuration → clear wizard error (no detail leak).
- Loopback timeout/rejection → flow cancelled, no orphaned account.
- Transient refresh failure (network) ≠ `invalid_grant` — only the latter sets
  `requires_reauth`.

### Security (hard rules)

Refresh token only in keychain; access token only in memory; **no token reaches the DB,
logs, events, `Debug`, or error messages**. `state` validated (CSRF), `redirect_uri`
loopback-only, PKCE S256, ephemeral verifier. userinfo instead of id_token parsing.
Carry-over rules: code identifiers English-only, no code comments (significant notes go
to `docs/`).

### Tests (5C)

Removing an account deletes rows + calls keychain delete + cancels the worker (with a
fake credential source); set/clear `requires_reauth`; `reorderAccounts` reorders
transactionally; frontend — remove-confirmation dialog, re-auth marker + re-run flow,
drag-drop reorder.

## Deferred (out of Etap 5)

- Microsoft/Apple/Exchange OAuth providers (post-MVP).
- id_token signature verification (userinfo used instead).
- Account edit (name/color) → Etap 7.
- Cross-account threading in smart folders (intentionally flat).
- Snoozed smart folder → Etap 6.
