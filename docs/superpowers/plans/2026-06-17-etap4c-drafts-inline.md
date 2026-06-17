# Etap 4C — Server Drafts Sync + Inline Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Depends on plans 4A (build_message, drafts_repo, send drain, IMAP append) and 4B (composer, save_draft, attachments). This is the highest-risk extension and the natural cut point if scope must shrink.

**Goal:** Mirror drafts to the server's Drafts folder (APPEND, replacing the prior copy), and support inline images (cid:) end-to-end (compose MIME `multipart/related` + a TipTap image node rewritten to `cid:` on save).

**Architecture:** Server Drafts sync is best-effort and queued (`sync_draft` op) so autosave never blocks; the worker appends the current draft MIME to Drafts, deletes the previously-stored server UID, and records the new UID on the draft row. Inline images are regular `attachments` rows carrying a `content_id`; `build_message` wraps the alternative body in `multipart/related` when any inline part exists; the composer rewrites `<img>` `src` to `cid:<id>` at save time.

**Tech Stack:** Rust (am-protocols/am-mime/am-storage/am-sync), React 19 + TipTap image extension.

## Global Constraints

- Node >= 24 (`$HOME/.nvm/versions/node/v24.14.0/bin`) for npm steps.
- English-only identifiers/constants/DB strings. No code comments (no eslint-disable).
- Conventional Commits; no `Co-Authored-By`; never `git push` unless asked.
- Secrets only in the keychain; passwords never logged. Inline image HTML still flows through the sanitizer at build time (4A) — `cid:` is an allowed img scheme already (per the Etap 1 sanitizer).
- `am-sync` stays Tauri-free.
- `cargo test --workspace` and `npm test` green; GreenMail integration tests skip without Docker.

---

### Task 1: IMAP APPENDUID + delete-by-uid

**Files:**
- Modify: `crates/am-protocols/src/imap.rs`

**Interfaces:**
- Produces:
```rust
impl ImapSession {
    pub async fn append_returning_uid(&mut self, folder: &str, flags: &str, bytes: &[u8]) -> Result<Option<i64>, ProtocolError>;
    pub async fn delete_uid(&mut self, folder: &str, uid: i64) -> Result<(), ProtocolError>; // select, UID STORE +FLAGS \Deleted, UID EXPUNGE/EXPUNGE
}
```

- [ ] **Step 1: Implement `append_returning_uid`**

Build on the existing `append`. Capture the `APPENDUID` from the UIDPLUS response if the server returns one; otherwise return `None`.

```rust
impl ImapSession {
    pub async fn append_returning_uid(&mut self, folder: &str, flags: &str, bytes: &[u8]) -> Result<Option<i64>, ProtocolError> {
        let resp = match &mut self.session {
            SessionStream::Plain(s) => s.append(folder, bytes).flags(flags).finish().await?,
            SessionStream::Tls(s) => s.append(folder, bytes).flags(flags).finish().await?,
        };
        Ok(extract_appenduid(&resp))
    }
}
```

VERIFY against async-imap 0.11.2: what `append(...).finish().await` returns (it may be `()` or an `Appended`/response struct exposing `uid`/`uid_validity`). If the library does not surface APPENDUID, return `None` and fall back to UID search by Message-ID in Task 2. Implement `extract_appenduid` to read the UID from whatever the library returns; if nothing is available, make it always return `None` and document that the fallback path is used.

- [ ] **Step 2: Implement `delete_uid`**

```rust
impl ImapSession {
    pub async fn delete_uid(&mut self, folder: &str, uid: i64) -> Result<(), ProtocolError> {
        match &mut self.session {
            SessionStream::Plain(s) => { s.select(folder).await?; let _: Vec<_> = s.uid_store(&uid.to_string(), "+FLAGS (\\Deleted)").await?.try_collect().await?; s.expunge().await?.try_collect::<Vec<_>>().await?; }
            SessionStream::Tls(s) => { s.select(folder).await?; let _: Vec<_> = s.uid_store(&uid.to_string(), "+FLAGS (\\Deleted)").await?.try_collect().await?; s.expunge().await?.try_collect::<Vec<_>>().await?; }
        }
        Ok(())
    }
}
```

VERIFY `expunge()` return type (stream of expunged seq numbers) and that `uid_store` matches the existing `store_flag` usage. Adjust collection as needed.

- [ ] **Step 3: Build**

Run: `cargo build -p am-protocols`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add crates/am-protocols/src/imap.rs
git commit -m "feat(protocols): APPENDUID capture and delete-by-uid"
```

---

### Task 2: Server Drafts sync (queued)

**Files:**
- Modify: `crates/am-storage/src/drafts_repo.rs` (`set_server_uid`/`get_server_uid` on the draft row, reusing `messages.uid`)
- Modify: `crates/am-sync/src/send.rs` (`enqueue_draft_sync`, `drain_draft_sync`; also delete server copy on send)
- Modify: `crates/am-sync/src/engine.rs` (call `drain_draft_sync`)
- Modify: `crates/am-app/src/commands.rs` (`save_draft` enqueues a draft sync)

**Interfaces:**
- Produces (drafts_repo): `set_server_uid(db, draft_id, uid: Option<i64>)`, `get_server_uid(db, draft_id) -> Option<i64>` (stored in `messages.uid` of the draft row).
- Produces (send): `enqueue_draft_sync(db, draft_id)`, `drain_draft_sync(db, account_id, now)`.

- [ ] **Step 1: `set_server_uid`/`get_server_uid` + test**

Store the server Drafts UID in the draft row's `uid` column (NULL until first server append). Add the two helpers and a roundtrip test.

- [ ] **Step 2: `drain_draft_sync` in `send.rs`**

For each due `sync_draft` op (filter `op.op_type == "sync_draft"`): load the draft, build MIME (`build_message`), find the Drafts folder (`FolderType::Drafts` with a real `remote_path` — skip if none exists on the server), connect, `append_returning_uid(drafts_path, "\\Draft", bytes)`, then if a previous server uid existed `delete_uid(drafts_path, old)`, then `set_server_uid(db, draft_id, new_uid)`, `mark_done`. On error use the same backoff/cap pattern as `drain_outbox`. Coalesce: if several `sync_draft` ops target the same draft, process only the newest and `mark_done` the rest (the draft row already holds the latest content).

VERIFY: only sync to the server when a `FolderType::Drafts` folder with a server `remote_path` exists. The local-only "Drafts" folder created by `drafts_repo::ensure_drafts_folder` (4A) is also `FolderType::Drafts`; distinguish a server Drafts folder by checking it was discovered via `list_folders` sync (e.g. it has non-null `uidvalidity`/markers) vs the local placeholder. If unsure, skip server sync when `get_sync_markers().uidvalidity` is `None` for that folder.

- [ ] **Step 3: Delete server draft on send**

In `drain_outbox` (4A) success branch, before/after deleting the local draft, also: if `get_server_uid(db, draft_id)` is `Some(uid)` and a server Drafts folder exists, `delete_uid(drafts_path, uid)`. Keep it best-effort (ignore errors).

- [ ] **Step 4: Enqueue on save + worker wiring**

`save_draft` command (4B) calls `am_sync::send::enqueue_draft_sync(&state.db, id)` after persisting. In `engine.rs`, add `let _ = service::... drain_draft_sync(&db, account_id, now).await;` next to `drain_outbox` (use the correct `crate::send::drain_draft_sync` path).

- [ ] **Step 5: Build + test**

Run: `cargo test -p am-sync -p am-storage`
Expected: green (unit). The server-sync path is covered by a GreenMail assertion if you extend `send_greenmail.rs`: after `enqueue_draft_sync` + `drain_draft_sync`, the Drafts folder on the server contains the message (optional but recommended).

- [ ] **Step 6: Commit**

```bash
git add crates/am-storage/src/drafts_repo.rs crates/am-sync/src/send.rs crates/am-sync/src/engine.rs crates/am-app/src/commands.rs
git commit -m "feat(sync): mirror drafts to server Drafts folder"
```

---

### Task 3: Inline images in MIME (multipart/related)

**Files:**
- Modify: `crates/am-mime/src/compose.rs`

**Interfaces:**
- Consumes: `OutgoingAttachment.content_id` (Some => inline).
- Produces: `build_message` wraps the alternative body in `multipart/related` (with the inline image parts carrying `Content-ID`) when any attachment has `content_id = Some`; non-inline attachments still become `multipart/mixed` parts.

- [ ] **Step 1: Write the test**

```rust
#[test]
fn inline_image_becomes_related_part_with_content_id() {
    let mut m = base(); // from the 4A compose tests
    let dir = std::env::temp_dir().join(format!("am-inline-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("img.png");
    std::fs::write(&p, b"PNGDATA").unwrap();
    m.html_body = Some("<p><img src=\"cid:img1\"></p>".into());
    m.attachments.push(OutgoingAttachment {
        filename: "img.png".into(), mime_type: "image/png".into(),
        blob_ref: p.to_string_lossy().into_owned(), content_id: Some("img1".into()),
    });
    let bytes = build_message(&m);
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.to_lowercase().contains("multipart/related"));
    assert!(text.contains("img1"));
    let parsed = mail_parser::MessageParser::default().parse(&bytes).unwrap();
    assert!(parsed.body_html(0).is_some());
}
```

- [ ] **Step 2: Implement**

Split attachments into inline (`content_id.is_some()`) and regular. Build the alternative body; if inline parts exist, assemble a `multipart/related` whose root is the alternative and whose siblings are the inline image parts (each with `Content-ID: <id>` and `Content-Disposition: inline`). Then wrap with `multipart/mixed` for regular attachments as before.

VERIFY mail-builder 0.4 API for inline parts / `multipart/related` and setting `Content-ID`. mail-builder exposes building arbitrary part trees (e.g. `MimePart::new(...)` with `.inline()` / `.cid(...)` / nested `.body([...])`). Use the real API to produce: `mixed[ related[ alternative[text, html], inline-images... ], attachments... ]` (omit the mixed wrapper when there are no regular attachments, and the related wrapper when there are no inline images). Note any deviation; keep the alternative+attachment behavior from 4A intact for the no-inline case.

- [ ] **Step 3: Run — expect PASS**

Run: `cargo test -p am-mime compose`
Expected: PASS (4A tests + the inline test).

- [ ] **Step 4: Commit**

```bash
git add crates/am-mime/src/compose.rs
git commit -m "feat(mime): inline images via multipart/related"
```

---

### Task 4: Inline images in the composer (TipTap)

**Files:**
- Modify: `package.json` (`@tiptap/extension-image`)
- Modify: `src/features/composer/Composer.tsx`
- Modify: `src/features/composer/Composer.test.tsx`

**Interfaces:**
- Consumes: `commands.pickAttachment` (or a paste handler), `OutgoingAttachment` with `content_id`.

- [ ] **Step 1: Install the image extension**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm install @tiptap/extension-image
```

- [ ] **Step 2: Add image insertion + cid rewrite**

Add the `Image` extension to the editor. Provide an "Insert image" action: pick an image file (`commands.pickAttachment` filtered to images, or a paste/drop handler), generate a `content_id` (e.g. `inline-<n>@abeonmail`), add an `OutgoingAttachment { filename, mime_type, blob_ref, content_id: Some(id) }` to the draft's attachments, and insert an `<img>` node whose `src` is a local preview (the file path or a data URL for display). On SAVE (assembling `OutgoingMessage`), rewrite each inline `<img src>` that corresponds to an inline attachment to `src="cid:<id>"` in the `html_body` string before calling `saveDraft`. Keep the on-screen editor showing the previewable src; only the serialized `html_body` uses `cid:`.

VERIFY `@tiptap/extension-image` API (the `Image` extension, `editor.chain().focus().setImage({ src }).run()`), and that the editor's `getHTML()` plus a deterministic post-process maps preview src → `cid:`. The mapping must be unambiguous (track preview-src ↔ content_id pairs in component state).

- [ ] **Step 3: Test**

Extend `Composer.test.tsx`: simulate inserting an inline image (mock `pickAttachment` returning an image `OutgoingAttachment` with a `content_id`), then "Send"; assert the `saveDraft` call's `message.html_body` contains `cid:<id>` and `message.attachments` includes the inline attachment with that `content_id`. Mock TipTap as in 4B.

- [ ] **Step 4: Run tests + build**

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"; npm test && npm run build
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/features/composer
git commit -m "feat(ui): inline images in composer with cid rewrite"
```

---

## Self-Review

- **Spec coverage (4C scope):** server Drafts sync via APPEND/expunge, queued and best-effort (Tasks 1-2), delete server draft on send (Task 2 Step 3), inline images cid: end-to-end (compose MIME Task 3 + TipTap Task 4). Everything else was 4A/4B.
- **Placeholder scan:** concrete code/tests where deterministic; the heavier VERIFY notes (APPENDUID availability, expunge API, mail-builder related/CID API, TipTap image API) are real library checks with defined fallbacks (e.g. APPENDUID → UID-search-by-Message-ID fallback; skip server sync when no server Drafts folder).
- **Type consistency:** `append_returning_uid`/`delete_uid` (Task 1) consumed by `drain_draft_sync` and the send cleanup (Task 2). `set_server_uid`/`get_server_uid` (Task 2) pair on `messages.uid`. `OutgoingAttachment.content_id` (4A type) drives both the MIME branch (Task 3) and the composer rewrite (Task 4) — the same `cid:<id>` value links the `<img>` src and the `Content-ID`.
