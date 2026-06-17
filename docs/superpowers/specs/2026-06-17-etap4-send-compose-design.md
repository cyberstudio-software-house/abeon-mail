# Etap 4 — Send + Composer (design)

Status: approved for planning
Date: 2026-06-17
Builds on: Etap 1–3 (multi-account IMAP read + flags, background sync engine + offline queue, threading, conversation UI).

## Goal

Add outgoing mail: a rich-text composer (new / reply / reply-all / forward) with
attachments and signatures, offline-first sending through an outbox queue, a
saved copy in the Sent folder, and drafts persisted locally and (optionally) on
the server.

## Scope (locked decisions)

- Send model: outbox + queue (offline-first). "Send" persists the message and
  enqueues a send op; the background worker performs SMTP send → IMAP APPEND to
  Sent → cleanup. Retries with backoff, like Etap 3's flag queue.
- Body format: basic rich text (HTML) via TipTap (ProseMirror). Sent as
  `multipart/alternative` (text + html). Full WYSIWYG polish is later.
- Core (in scope): attachments (Tauri file dialog), local draft autosave,
  save-to-Sent, reply / reply-all / forward with correct thread headers.
- Extensions (in scope, sequenced last): server-side Drafts sync (IMAP APPEND),
  signatures, inline images (cid:).
- Auth: SMTP password auth (LOGIN/PLAIN) over TLS, same keychain password as
  IMAP. XOAUTH2 is Etap 5.

## Architecture

### One canonical raw message

A single canonical RFC822 byte string drives both transports: `am-mime` builds
it, `am-protocols::smtp` sends those bytes via `lettre`'s `send_raw(envelope,
bytes)`, and IMAP `APPEND` writes the SAME bytes to Sent/Drafts. There is no
divergence between "what we sent" and "what we saved".

### Outbox + queue

- A draft is persisted as: a `messages` row with `draft = 1`, a `message_bodies`
  row (html + plain), and `attachments` rows whose `blob_ref` points to a file
  on disk (attachment bytes are NOT stored in the DB). A new column carries BCC.
- "Send" → command `enqueue_send(draft_id)` → a `sync_queue` row
  (`op_type = "send_message"`, payload = draft id + account id).
- The Etap 3 per-account worker drains it: build RFC822 → SMTP `send_raw`
  (envelope = From + all recipients incl. BCC) → IMAP `APPEND` to Sent (flag
  `\Seen`) → delete the local draft (and the server Drafts copy if one exists).
  Backoff/retry and the existing failure-isolation apply.

### Backend modules

- `am-protocols/src/smtp.rs`: thin `lettre` wrapper —
  `send_raw(config, password, envelope, bytes)`. Implicit TLS (465) or STARTTLS
  (587) per `Endpoints.smtp_tls`/port; LOGIN/PLAIN auth with the keychain
  password. Uses the same rustls/ring provider as IMAP (validates certs).
- `am-protocols/src/imap.rs`: add `append(folder, flags, bytes)`.
- `am-mime/src/compose.rs` (mail-builder): `build_message(OutgoingMessage) ->
  Vec<u8>`. Assembly: `text/plain` (degraded from HTML) + `text/html` →
  `multipart/alternative`; + attachments → `multipart/mixed`; + inline images →
  `multipart/related`. Outgoing HTML is sanitized (ammonia); quoted original
  HTML is sanitized too.
- `am-sync/src/compose.rs`: build a draft from a compose action. Reply: recipient
  from From/Reply-To; reply-all adds To+Cc minus own address; subject `Re:` /
  `Fwd:`; `In-Reply-To` + `References` (from Etap 3); quoted, sanitized original
  with an "On … wrote:" header. Forward appends the original (and its
  attachments).
- `am-sync` stays Tauri-free; send/draft orchestration emits through the existing
  `SyncEventSink`.

## Frontend

- Composer (modal/pane) built on TipTap StarterKit (bold/italic/lists/headings/
  links) + toolbar. Fields: From (account select), To/Cc/Bcc (chips), Subject,
  body. Attachments via the Tauri file dialog. Insert signature. Paste/embed
  inline image.
- Entry points: "New", and "Reply / Reply-all / Forward" from the conversation
  reader, prefilling recipients, subject, quoted body, and thread headers.
- Autosave (debounced) → `save_draft`. "Send" → `enqueue_send`. Outbox/Sent
  state refreshed via events.

## Extensions

- Server Drafts sync: APPEND to the Drafts folder on autosave, removing the prior
  copy by UID. Local draft always; server copy only when a Drafts folder exists.
- Signatures: use the existing `signatures` table — default signature inserted
  into new messages/replies, with a simple picker.
- Inline images (cid:): `multipart/related` with image parts carrying
  `Content-ID`; a TipTap image node is rewritten to `cid:` on save. Sequenced as
  the last sub-plan (highest risk, the natural cut point if scope must shrink).

## Commands / events

- Commands: `save_draft`, `list_drafts` / `get_draft`, `enqueue_send`,
  `discard_draft`, `pick_attachment` (dialog), `list_signatures`.
- Events: reuse `mailbox_changed`; add `outbox_changed` if a distinct outbox view
  needs it.

## Dependencies

- `lettre` (async SMTP transport; rustls/ring to match IMAP).
- `mail-builder` (MIME construction; same author as mail-parser already used).
- TipTap (frontend rich-text editor).

## Testing & quality gate (security / performance / clean code)

- GreenMail covers SMTP too: e2e — compose → enqueue → worker SMTP send →
  message lands in the recipient mailbox + the Sent APPEND is verifiable.
- Unit: MIME building (alternative/mixed/related, outgoing-HTML sanitization),
  reply/forward quoting, reply-all recipient set (excludes self).
- Security: password only in the keychain; outgoing AND quoted HTML pass through
  the sanitizer; BCC never appears in headers — only in the SMTP envelope.
- Performance: attachment blobs live on disk (not DB/memory); stream rather than
  buffer where practical.
- Clean code: the canonical raw RFC822 is the single source; `am-sync` stays
  Tauri-free; focused modules (smtp.rs, compose.rs).

## Sub-plans

- 4A — backend send pipeline: `lettre`/`mail-builder`, `smtp.rs`, IMAP `append`,
  MIME compose, outbox + send-op in the worker, save-to-Sent, commands + GreenMail
  e2e.
- 4B — composer (TipTap) + reply/reply-all/forward + attachments + local autosave
  + signatures.
- 4C — server Drafts sync (APPEND/expunge) + inline images (cid:).

## Out of scope (later etaps)

- OAuth / XOAUTH2 send (Etap 5), full WYSIWYG polish, scheduled send, read
  receipts, PGP/S-MIME.
