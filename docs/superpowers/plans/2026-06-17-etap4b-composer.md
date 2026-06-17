# Etap 4B — Composer + Reply/Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Depends on plan 4A (OutgoingMessage, drafts_repo, enqueue_send, build_message, SMTP/Sent pipeline).

**Goal:** A rich-text composer (new / reply / reply-all / forward) with attachments, signatures, and debounced local autosave, wired to the 4A outbox pipeline.

**Architecture:** Reply/forward prefill is computed in `am-sync::compose` (deterministic, unit-tested) from the stored message row + parsed body. The frontend composer (TipTap StarterKit) edits an `OutgoingMessage`-shaped draft; `save_draft` persists it, `enqueue_send` sends it. Attachments are picked via the Tauri dialog plugin; the chosen file path is the `blob_ref`.

**Tech Stack:** Rust (am-sync/am-mime/am-storage/am-app), React 19 + @tiptap/react + @tiptap/starter-kit, @tanstack/react-query, Tauri dialog plugin.

## Global Constraints

- Node >= 24 (`$HOME/.nvm/versions/node/v24.14.0/bin`) for all npm steps.
- English-only identifiers/constants/DB strings. No code comments (no eslint-disable).
- Conventional Commits; no `Co-Authored-By`; never `git push` unless asked.
- Secrets only in the OS keychain. Quoted original HTML in replies/forwards MUST pass through the ammonia sanitizer (`am_mime::sanitize::sanitize_html`) before being embedded. Outgoing HTML is sanitized again at build time (4A).
- BCC only in the SMTP envelope (4A) — the composer's BCC field never becomes a header.
- `am-sync` stays Tauri-free.
- `cargo test --workspace` and `npm test` green.

---

### Task 1: Capture To/Cc when parsing bodies

**Files:**
- Modify: `crates/am-mime/src/parse.rs` (`ParsedMessage` gains `to`/`cc`)

**Interfaces:**
- Produces: `ParsedMessage` gains `pub to: Vec<String>` and `pub cc: Vec<String>` (addresses only).

- [ ] **Step 1: Write the failing test in `parse.rs` tests**

```rust
#[test]
fn parses_to_and_cc_addresses() {
    let raw = b"From: a@x.com\r\nTo: b@y.com, c@z.com\r\nCc: d@w.com\r\nSubject: S\r\n\r\nbody\r\n";
    let parsed = parse_message(raw);
    assert_eq!(parsed.to, vec!["b@y.com".to_string(), "c@z.com".to_string()]);
    assert_eq!(parsed.cc, vec!["d@w.com".to_string()]);
}
```

- [ ] **Step 2: Run — expect FAIL** (no `to` field), then implement

Add `to: Vec<String>` and `cc: Vec<String>` to the `ParsedMessage` struct and the early-return literal. Populate them in `parse_message`:

```rust
fn addresses(addr: Option<&Address>) -> Vec<String> {
    match addr {
        Some(Address::List(list)) => list.iter().filter_map(|a| a.address.as_deref().map(str::to_string)).collect(),
        Some(Address::Group(groups)) => groups.iter().flat_map(|g| g.addresses.iter()).filter_map(|a| a.address.as_deref().map(str::to_string)).collect(),
        None => Vec::new(),
    }
}
```

and in `parse_message`: `let to = addresses(msg.to()); let cc = addresses(msg.cc());` then include them in the returned `ParsedMessage`. Update the malformed/early-return literal to `to: Vec::new(), cc: Vec::new()`.

VERIFY `msg.to()` / `msg.cc()` return `Option<&Address>` in mail-parser 0.11.3 (the `from()` path already uses `Address::List`/`Group`). Adjust the helper to the real return type.

- [ ] **Step 3: Run — expect PASS**

Run: `cargo test -p am-mime parse`
Expected: PASS (existing + new).

- [ ] **Step 4: Commit**

```bash
git add crates/am-mime/src/parse.rs
git commit -m "feat(mime): capture To/Cc addresses when parsing"
```

---

### Task 2: Reply/forward prefill (am-sync compose)

**Files:**
- Create: `crates/am-sync/src/compose.rs`
- Modify: `crates/am-sync/src/lib.rs` (`pub mod compose;`)
- Modify: `crates/am-storage/src/messages_repo.rs` (`get_compose_source`)

**Interfaces:**
- Produces (messages_repo): `get_compose_source(db, message_id) -> Result<ComposeSource, StorageError>` where
```rust
pub struct ComposeSource {
    pub account_id: i64,
    pub from_address: String, pub from_name: Option<String>,
    pub subject: String, pub message_id_hdr: Option<String>, pub references_hdr: Option<String>,
}
```
- Produces (compose): pure functions
```rust
pub enum ReplyMode { Reply, ReplyAll, Forward }
pub fn normalize_reply_subject(subject: &str, mode: ReplyMode) -> String; // "Re: "/"Fwd: " without doubling
pub fn build_recipients(mode: ReplyMode, self_addr: &str, src_from: &str, src_to: &[String], src_cc: &[String]) -> (Vec<String>, Vec<String>); // (to, cc)
pub fn build_references(src_references: &[String], src_message_id: Option<&str>) -> Vec<String>;
pub fn quote_html(original_html: &str, attribution: &str) -> String; // sanitized blockquote
pub fn quote_text(original_text: &str, attribution: &str) -> String; // "> " prefixed
```
plus an async assembler:
```rust
pub async fn build_prefill(db, message_id: i64, mode: ReplyMode) -> Result<(i64, am_core::outgoing::OutgoingMessage), SyncError>; // (account_id, prefilled draft message)
```

- [ ] **Step 1: `messages_repo::get_compose_source` + test**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeSource {
    pub account_id: i64,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub message_id_hdr: Option<String>,
    pub references_hdr: Option<String>,
}

pub fn get_compose_source(db: &Database, message_id: i64) -> Result<ComposeSource, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT account_id, from_address, from_name, subject, message_id_hdr, references_hdr FROM messages WHERE id=?1",
        params![message_id],
        |r| Ok(ComposeSource {
            account_id: r.get(0)?, from_address: r.get(1)?, from_name: r.get(2)?,
            subject: r.get(3)?, message_id_hdr: r.get(4)?, references_hdr: r.get(5)?,
        }),
    ).map_err(|e| match e { rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound, o => StorageError::Sqlite(o) })
}
```

Add a roundtrip test inserting one header (via `insert_headers` with a `message_id_hdr`) and asserting the source fields.

- [ ] **Step 2: Pure compose helpers + tests in `compose.rs`**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyMode { Reply, ReplyAll, Forward }

pub fn normalize_reply_subject(subject: &str, mode: ReplyMode) -> String {
    let trimmed = subject.trim();
    let prefix = match mode { ReplyMode::Forward => "Fwd: ", _ => "Re: " };
    let lower = trimmed.to_ascii_lowercase();
    let already = match mode {
        ReplyMode::Forward => lower.starts_with("fwd:") || lower.starts_with("fw:"),
        _ => lower.starts_with("re:"),
    };
    if already { trimmed.to_string() } else { format!("{prefix}{trimmed}") }
}

pub fn build_recipients(mode: ReplyMode, self_addr: &str, src_from: &str, src_to: &[String], src_cc: &[String]) -> (Vec<String>, Vec<String>) {
    let self_l = self_addr.to_ascii_lowercase();
    let eq = |a: &str| a.to_ascii_lowercase() == self_l;
    match mode {
        ReplyMode::Forward => (Vec::new(), Vec::new()),
        ReplyMode::Reply => (vec![src_from.to_string()], Vec::new()),
        ReplyMode::ReplyAll => {
            let to = vec![src_from.to_string()];
            let mut cc = Vec::new();
            for a in src_to.iter().chain(src_cc.iter()) {
                if !eq(a) && a.to_ascii_lowercase() != src_from.to_ascii_lowercase() && !cc.iter().any(|c: &String| c.eq_ignore_ascii_case(a)) {
                    cc.push(a.clone());
                }
            }
            (to, cc)
        }
    }
}

pub fn build_references(src_references: &[String], src_message_id: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = src_references.to_vec();
    if let Some(mid) = src_message_id {
        if !out.iter().any(|r| r == mid) { out.push(mid.to_string()); }
    }
    out
}

pub fn quote_html(original_html: &str, attribution: &str) -> String {
    let safe = crate::sanitize_original(original_html);
    format!("<p>{attribution}</p><blockquote>{safe}</blockquote>")
}

pub fn quote_text(original_text: &str, attribution: &str) -> String {
    let quoted: String = original_text.lines().map(|l| format!("> {l}\n")).collect();
    format!("{attribution}\n{quoted}")
}
```

Add a tiny private wrapper in compose.rs: `fn sanitize_original(html: &str) -> String { am_mime::sanitize::sanitize_html(html).html }`.

Tests: `normalize_reply_subject` (Re: no-double, Fwd:), `build_recipients` reply-all excludes self and the sender-duplicated address and dedupes, `build_references` appends message-id without duplicating, `quote_html` wraps in blockquote and the result contains no `<script>` even if the original did (feed `"<script>x</script><p>hi</p>"`, assert no `<script>`).

- [ ] **Step 3: Async `build_prefill` assembler**

```rust
use am_core::outgoing::OutgoingMessage;
use am_storage::{accounts_repo, messages_repo};
use crate::service::{get_or_fetch_body, SyncError};

pub async fn build_prefill(db: &am_storage::Database, message_id: i64, mode: ReplyMode) -> Result<(i64, OutgoingMessage), SyncError> {
    let src = messages_repo::get_compose_source(db, message_id)?;
    let account = accounts_repo::get_account(db, src.account_id)?;
    let body = get_or_fetch_body(db, message_id).await?;
    let parsed = am_mime::parse::parse_message(&[]); // see note
    let (to, cc) = build_recipients(mode, &account.email, &src.from_address, &parsed.to, &parsed.cc);
    let subject = normalize_reply_subject(&src.subject, mode);
    let references = build_references(
        &src.references_hdr.as_deref().map(|s| s.split_whitespace().map(String::from).collect::<Vec<_>>()).unwrap_or_default(),
        src.message_id_hdr.as_deref(),
    );
    let attribution = format!("On an earlier date, {} wrote:", src.from_name.clone().unwrap_or(src.from_address.clone()));
    let html_body = body.text_html.as_deref().map(|h| quote_html(h, &attribution));
    let text_body = quote_text(body.text_plain.as_deref().unwrap_or(""), &attribution);
    Ok((src.account_id, OutgoingMessage {
        from_address: account.email.clone(), from_name: Some(account.display_name.clone()),
        to, cc, bcc: vec![], subject, text_body, html_body,
        in_reply_to: src.message_id_hdr.clone(), references, attachments: vec![],
    }))
}
```

NOTE: `parsed.to`/`parsed.cc` must come from the SOURCE message body, not an empty parse. `get_or_fetch_body` returns only text/html. Add a helper that returns To/Cc too: extend `get_or_fetch_body` is overkill; instead add `messages_repo`-independent parsing — fetch the raw via a new `service` helper `fetch_raw(db, message_id) -> Vec<u8>` OR have `build_prefill` call a new `get_or_fetch_recipients(db, message_id) -> (Vec<String>, Vec<String>)` that fetches+parses To/Cc (cache acceptable). Implement `get_or_fetch_recipients` in `service.rs` reusing the same fetch path as `get_or_fetch_body` and `am_mime::parse::parse_message` (which now yields to/cc from Task 1). Replace the placeholder `parse_message(&[])` line with a call to it. Reply/ReplyAll need recipients; Forward does not (it returns empty to/cc) — so for Forward you may skip the recipient fetch.

- [ ] **Step 4: Run — expect PASS**

Run: `cargo test -p am-sync compose && cargo test -p am-storage get_compose_source`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/am-sync/src/compose.rs crates/am-sync/src/lib.rs crates/am-storage/src/messages_repo.rs crates/am-sync/src/service.rs
git commit -m "feat(sync): reply/reply-all/forward prefill computation"
```

---

### Task 3: Signatures + compose/draft commands

**Files:**
- Create: `crates/am-storage/src/signatures_repo.rs`
- Modify: `crates/am-storage/src/lib.rs`
- Modify: `crates/am-app/src/commands.rs`, `crates/am-app/src/lib.rs`
- Modify: `crates/am-app/Cargo.toml` + `src-tauri/Cargo.toml`/`tauri.conf.json` (dialog plugin)

**Interfaces:**
- Produces (signatures_repo): `list_signatures(db, account_id) -> Vec<Signature>` where `Signature { id, name, html, is_default }` (am-core type).
- Produces commands: `start_reply(message_id, mode) -> Result<OutgoingMessage,String>` (mode as a string "reply"|"reply_all"|"forward"), `save_draft(account_id, draft_id: Option<i64>, message: OutgoingMessage) -> Result<i64,String>`, `get_draft(draft_id) -> Result<OutgoingMessage,String>`, `list_drafts(account_id) -> Result<Vec<i64>,String>`, `discard_draft(draft_id) -> Result<(),String>`, `list_signatures(account_id) -> Result<Vec<Signature>,String>`, `pick_attachment() -> Result<Vec<OutgoingAttachment>,String>` (Tauri dialog).

- [ ] **Step 1: `Signature` type (am-core) + `signatures_repo` + test**

Add `Signature { id: i64, name: String, html: String, is_default: bool }` to a new `am-core/src/signature.rs` (serde + specta), `pub mod signature;`. Implement `list_signatures` reading the `signatures` table. Test: insert a signature row, assert list returns it.

- [ ] **Step 2: Add the Tauri dialog plugin**

Add `tauri-plugin-dialog = "2"` to `src-tauri/Cargo.toml`, register `.plugin(tauri_plugin_dialog::init())` in `src-tauri/src/lib.rs`, and add the dialog capability to `src-tauri/capabilities/*.json` (or `tauri.conf.json`). `pick_attachment` uses the dialog to choose files; for each, build an `OutgoingAttachment { filename, mime_type (guess from extension), blob_ref = path, content_id: None }`. VERIFY the dialog plugin's Rust API (`tauri_plugin_dialog::DialogExt::dialog().file().blocking_pick_files()` or the async variant) against the installed version; the command may need to run on the async runtime.

- [ ] **Step 3: Commands + registration**

Add the commands (each delegates to `drafts_repo`/`signatures_repo`/`compose::build_prefill`, mapping errors to generic strings). `start_reply` parses the mode string into `ReplyMode` and calls `build_prefill`. Register all in `collect_commands!`.

- [ ] **Step 4: Build + regen bindings + test**

```bash
cargo test -p am-app -p am-storage -p am-core
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"; npm run gen:bindings
```
Confirm `startReply`, `saveDraft`, `getDraft`, `listDrafts`, `discardDraft`, `listSignatures`, `pickAttachment`, and types `OutgoingMessage`/`OutgoingAttachment`/`Signature` appear in bindings.

- [ ] **Step 5: Commit**

```bash
git add crates/ src-tauri/ src/ipc/bindings.ts
git commit -m "feat(app): compose/draft/signature commands and attachment picker"
```

---

### Task 4: TipTap composer component

**Files:**
- Modify: `package.json` (TipTap deps)
- Create: `src/features/composer/Composer.tsx`, `src/features/composer/composer.css`, `src/features/composer/RecipientField.tsx`
- Create: `src/features/composer/Composer.test.tsx`
- Modify: `src/app/store.ts` (composer open state)

**Interfaces:**
- Consumes: generated `commands.saveDraft`/`enqueueSend`/`getDraft`/`listSignatures`/`pickAttachment`, types `OutgoingMessage`/`OutgoingAttachment`.

- [ ] **Step 1: Install TipTap**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm install @tiptap/react @tiptap/pm @tiptap/starter-kit
```

- [ ] **Step 2: Composer state in the store**

Add to `store.ts`: `composer: { open: boolean; draftId: number | null }` plus `openComposer(draftId: number | null)` and `closeComposer()`.

- [ ] **Step 3: Build the `Composer` component**

A modal with: From (account select), To/Cc/Bcc via `RecipientField` (comma/enter to add chips), Subject input, a TipTap `EditorContent` with a `StarterKit` editor + a small toolbar (bold/italic/bullet list/link), an attachments row (button → `commands.pickAttachment` → list chips), an "Insert signature" button (`commands.listSignatures` → insert default html into the editor), and footer buttons "Send" / "Save draft" / "Discard". The editor's `getHTML()` is the `html_body`; derive `text_body` from the editor's `getText()`.

```tsx
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
// ... editor = useEditor({ extensions: [StarterKit], content: initialHtml })
```

Assemble an `OutgoingMessage` from the fields and call `commands.saveDraft(accountId, draftId, message)` (returns id) / `commands.enqueueSend(id)`.

VERIFY TipTap React 19 compatibility and the `useEditor`/`EditorContent` import paths for the installed versions; adjust if the package layout differs.

- [ ] **Step 4: Component test (happy-dom)**

`Composer.test.tsx`: mock `./ipc/bindings` (`saveDraft` returns `{status:"ok",data:1}`, `enqueueSend` ok, `listSignatures` ok). Render the composer with a recipient + subject + body; click "Send"; assert `commands.saveDraft` then `commands.enqueueSend` were called (saveDraft first to get an id, then enqueueSend with that id). Mock TipTap if needed (a simple textarea stand-in) following the existing mocked-bindings test patterns; keep the assertion on the command call sequence, not editor internals.

- [ ] **Step 5: Run tests + build**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"; npm test && npm run build
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/app/store.ts src/features/composer
git commit -m "feat(ui): TipTap composer component"
```

---

### Task 5: Entry points + autosave + send wiring

**Files:**
- Modify: `src/features/reader/ConversationView.tsx` (Reply/Reply-all/Forward buttons)
- Modify: `src/app/AppShell.tsx` (mount Composer modal; "New" button)
- Modify: `src/ipc/queries.ts` (mutations: `useSaveDraft`, `useEnqueueSend`, `useStartReply`)
- Modify: `src/features/composer/Composer.tsx` (debounced autosave)
- Create/extend tests

**Interfaces:**
- Consumes: composer store state, the Task 3 commands.

- [ ] **Step 1: Mutations/hooks in `queries.ts`**

`useStartReply()` → `commands.startReply(messageId, mode)` returns a prefilled `OutgoingMessage`; `useSaveDraft()` → `commands.saveDraft(...)`; `useEnqueueSend()` → `commands.enqueueSend(id)` (invalidate `["folders"]`/`["threads"]` on success — the Sent folder gains the message after the worker drains).

- [ ] **Step 2: Entry points**

In `ConversationView`, add Reply / Reply-all / Forward buttons per message (or per conversation) that call `startReply(messageId, mode)`, then `openComposer` with the returned prefill loaded into the editor. In `AppShell`, add a "New" button that `openComposer(null)` with an empty draft, and mount `<Composer />` when `composer.open`.

- [ ] **Step 3: Debounced autosave**

In `Composer`, debounce (≈1.5s) field/editor changes → `saveDraft` (carrying the current `draftId`, updating it from the first save's returned id). On "Discard" → `commands.discardDraft(draftId)` if set + `closeComposer`.

- [ ] **Step 4: Tests**

Extend/maintain: a test that clicking "Reply" calls `startReply` with the message id and mode "reply" and opens the composer; assert autosave calls `saveDraft` after edits (use fake timers). Keep to mocked-bindings patterns.

- [ ] **Step 5: Run tests + build**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"; npm test && npm run build
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/features src/app src/ipc/queries.ts
git commit -m "feat(ui): composer entry points, autosave, send wiring"
```

---

## Self-Review

- **Spec coverage (4B scope):** reply/reply-all/forward prefill with thread headers + sanitized quoting (Task 2), signatures (Task 3), attachments via Tauri dialog (Task 3), TipTap composer (Task 4), autosave + send wiring + entry points (Task 5). Server Drafts sync and inline images are 4C.
- **Placeholder scan:** the Task 2 Step 3 `parse_message(&[])` line is explicitly flagged as a placeholder to replace with `get_or_fetch_recipients`; the NOTE defines that function's contract. All other steps carry concrete code or precise UI assembly instructions; VERIFY notes (mail-parser to/cc, dialog plugin API, TipTap imports) are real API checks.
- **Type consistency:** `OutgoingMessage`/`OutgoingAttachment` (4A) flow through `build_prefill` (Task 2), the commands (Task 3), and the composer (Tasks 4-5). `ReplyMode` (Task 2) is parsed from the `start_reply` mode string (Task 3). `ComposeSource`/`Signature` names match producer and consumers. `saveDraft` returns the draft id consumed by `enqueueSend`.
