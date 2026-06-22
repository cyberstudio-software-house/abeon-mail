# Microsoft mail integration (IMAP/SMTP + OAuth2)

Date: 2026-06-22
Status: approved, in implementation

## Goal

Let users add Microsoft accounts (both personal — Outlook.com/Hotmail/Live — and
work/school Microsoft 365) and sync them through the existing IMAP/SMTP engine,
authenticating with OAuth2 (XOAUTH2) instead of a password.

## Decisions

- **Account scope:** both personal and work/school. Azure authority: `common`.
- **Transport:** IMAP/SMTP + OAuth2 (XOAUTH2). The existing `am-protocols`/`am-sync`
  engine is reused unchanged. We add a second OAuth provider, not a second engine.
- **Email discovery:** read the `email` claim from the `id_token` returned by the
  token endpoint (fallback to `preferred_username`). No extra network call, no Graph
  `/me`, no crypto dependency — the JWT payload is base64url-decoded and trusted
  because it arrived directly from the token endpoint over TLS.
- **Client type:** public/native client. Microsoft does **not** issue a client secret
  for this flow; refresh and code-exchange requests omit `client_secret`.

## External prerequisite (handled by the user)

Microsoft Entra ID app registration:
- Supported account types: any org directory + personal Microsoft accounts (`common`).
- Platform "Mobile and desktop applications", redirect URI `http://127.0.0.1`
  (loopback: Microsoft accepts a dynamic port).
- "Allow public client flows" = Yes.
- Delegated permissions: `https://outlook.office.com/IMAP.AccessAsUser.All`,
  `https://outlook.office.com/SMTP.Send`, `offline_access`, `openid`, `email`.
- Output consumed by the code: **Application (client) ID** (no secret).

## What is reused unchanged

- `am-protocols` IMAP/SMTP with `XOauth2 { user, access_token }`.
- `am-sync` sync engine, IDLE, send queue.
- `OAuthTokenManager` (token cache + refresh from keychain), PKCE primitives,
  loopback redirect flow, keychain credential storage.

## Provider-specific surface (what changes)

The core idea: introduce one **provider descriptor** so differences live in data, not
in `if microsoft { … }` branches scattered through the flow.

### am-auth

1. **`OAuthProvider` descriptor** (new). Fields: `auth_uri`, `token_uri`, `scopes`,
   `extra_auth_params` (Google: `access_type=offline&prompt=consent`; Microsoft:
   `prompt=select_account`), `uses_client_secret: bool`, `email_source`
   (`Userinfo(url)` for Google, `IdTokenClaim` for Microsoft). Constructors
   `OAuthProvider::google()` and `OAuthProvider::microsoft()`.
2. **`oauth/microsoft.rs`** (new, mirrors `google.rs`): authority URIs on `common`,
   the scope string above, `microsoft_client_id()` resolving runtime env →
   baked `option_env!("ABEONMAIL_MICROSOFT_CLIENT_ID")`. No secret.
3. **`build.rs`**: add `ABEONMAIL_MICROSOFT_CLIENT_ID` to `BAKED_VARS`.
4. **`oauth/pkce.rs`**: `authorize_url` takes the provider's `auth_uri`, `scopes`,
   and `extra_auth_params` instead of the hardcoded Google constants.
5. **`oauth/client.rs`**: `exchange_code` / `refresh_tokens` take the token endpoint
   and a "send secret" flag. When `uses_client_secret` is false, `client_secret` is
   omitted from the form. `parse_token_response` also captures `id_token` when present.
6. **Email from id_token** (new): decode the JWT payload, read `email` (fallback
   `preferred_username`).

### am-core

7. `ProviderType::MicrosoftOauth` (db string `microsoft_oauth`) added to the enum,
   `as_db_str`, `from_db_str`.

### am-sync

8. `KeychainCredentialSource`: hold a Microsoft `client_id` (no secret) and add a
   `ProviderType::MicrosoftOauth` arm in `auth_for`, refreshing via the Microsoft
   token endpoint without a secret.

### am-app (commands) + src-tauri

9. `run_microsoft_oauth_flow` mirroring `run_google_oauth_flow`, and a
   `begin_microsoft_oauth` Tauri command that stores the refresh token, inserts the
   account with forced `outlook.office365.com` / `smtp.office365.com:587` endpoints
   (domain-based `endpoints::resolve` would miss M365 custom domains), seeds the token
   manager, and spawns the account. Register the command in `am-app/src/lib.rs`.

### Frontend

10. `bindings.ts` regenerated with `beginMicrosoftOauth`; a `useBeginMicrosoftOauth`
    mutation in `queries.ts`; a "Sign in with Microsoft" button in `AddAccountWizard`.

## Error handling

- Reuse existing `OAuthError` → `SyncError` mapping (`InvalidGrant` → `NeedsReauth`).
- M365 tenants with SMTP AUTH disabled: IMAP works, SMTP send fails. The existing
  `SendFailed` event + last_error surface this; map the SMTP rejection to a readable
  message rather than a raw protocol error.

## Build sequence (TDD, each step its own commit)

1. `ProviderType::MicrosoftOauth` (am-core) — smallest, unblocks everything.
2. `OAuthProvider` descriptor + `microsoft.rs` + `build.rs` baking (am-auth).
3. `authorize_url` parametrized by provider (am-auth/pkce).
4. `exchange_code` / `refresh_tokens` parametrized by endpoint + secret flag (am-auth/client).
5. id_token email extraction (am-auth).
6. `KeychainCredentialSource` Microsoft arm (am-sync).
7. `run_microsoft_oauth_flow` + `begin_microsoft_oauth` command (am-app) + registration.
8. Frontend: binding + query + wizard button.

## Out of scope (deferred)

- Microsoft Graph API transport (possible future third `ProviderType`; the descriptor
  abstraction keeps the door open).
- POP3, calendar/contacts, shared mailboxes.
