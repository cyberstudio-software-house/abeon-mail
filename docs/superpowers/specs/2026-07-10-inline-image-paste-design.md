# Inline Image Paste — Design

Date: 2026-07-10

## Goal

Let the user place images directly into the mail body in the composer by
**pasting** (Ctrl+V, e.g. screenshots or copied image bytes) and by
**dragging & dropping** image files onto the editor. Pasted/dropped images are
embedded in the sent message as MIME `cid:` parts (`multipart/related`), matching
the existing inline-image pattern.

## Scope

In scope:
- Paste from clipboard (`image/*` bytes).
- Drag & drop of image files onto the editor.
- Embedding as `cid:` MIME parts.
- Draft persistence: a draft containing a pasted image survives app restart.

Out of scope:
- Images copied from web pages that arrive as HTML with an `http` URL (would
  require network download). Explicitly deferred.
- Aggressive cleanup of inline image files after a successful send (see
  Known Limitations).

## Existing infrastructure (reused unchanged)

- TipTap `Image` extension is already registered
  (`src/features/composer/editor/extensions.ts`).
- `inlineSrcMapRef` maps a preview `src` → `content_id`
  (`Composer.tsx:67`).
- `rewriteInlineSrcs` rewrites `<img src="...">` → `src="cid:<id>"` at send/autosave
  (`Composer.tsx:22-30`). Regex `src="([^"]*)"` handles `data:` URIs (no `"` in base64).
- Backend `build_message` already builds `multipart/related` with `Content-ID`
  for attachments whose `content_id.is_some()`
  (`crates/am-mime/src/compose.rs:62-103`), reading bytes from disk via
  `std::fs::read(&att.blob_ref)`.
- Sanitizer already allows `cid:` and `data:image/*`
  (`crates/am-mime/src/sanitize.rs`). No sanitizer change needed.
- `attachments` table already has `content_id` and `blob_ref` columns. No DB
  migration needed.

## Chosen approach

Frontend reads the pasted/dropped image as a `Blob`, converts to base64, and calls
a new Rust command that persists the bytes and returns an `OutgoingAttachment`
(matching `pick_attachment`). One code path serves both paste and drop, because
both produce a `Blob`/`File` in JS.

Rejected alternatives:
- Reading the clipboard image in Rust via a Tauri clipboard plugin — drag & drop
  still needs the frontend, producing two divergent paths.
- `data:` URI only (no `cid` part) — rejected; the user chose `cid:` embedding for
  better client compatibility and smaller HTML.

## Data flow

### Paste / drop
1. `editorProps.handlePaste` / `handleDrop` in `useEditor` detect `image/*` in
   `clipboardData.items` / `dataTransfer.files`.
2. Frontend: `Blob → base64`, build `data:<mime>;base64,...` for preview.
3. `await commands.saveInlineImage(mime, base64)` → backend writes the bytes into
   application data and returns
   `OutgoingAttachment { filename, mime_type, blob_ref, content_id: None }`.
4. Frontend generates a `content_id` (same as `handleInsertImage`) and, atomically:
   `setImage({ src: dataUri })`, `inlineSrcMapRef.set(dataUri, contentId)`,
   append the attachment (with `content_id`) to state, `scheduleAutosave()`.
5. On send/autosave `rewriteInlineSrcs` rewrites `data:` → `cid:`; `build_message`
   builds the `multipart/related` part. No change to Rust MIME or the sanitizer.

To avoid a race, the preview + attachment are inserted **after** the `saveInlineImage`
await resolves (atomically), not before.

### Reopening a draft (persistence)
- `prefill.html_body` contains `<img src="cid:...">`; `prefill.attachments` carries
  `content_id` + `blob_ref`. `cid:` does not render in the webview, so the preview
  must be reconstructed.
- After the draft loads, for each attachment with a `content_id`:
  call `commands.readInlineImage(blob_ref)` → base64, build a `data:` URI from the
  attachment's `mime_type`, rewrite `cid:<id>` → `data:` in the HTML, and repopulate
  `inlineSrcMapRef`. The reconstructed HTML is then set into the editor via
  `editor.commands.setContent(...)` (replacing the direct `buildInitialContent` path
  for drafts that carry inline images).

## Backend (Rust)

Two new commands in `crates/am-app/src/commands.rs` (next to `pick_attachment`),
registered in the `specta` / `tauri::generate_handler` list.

### `save_inline_image(app, mime_type: String, data_base64: String) -> OutgoingAttachment`
- Decode base64 → bytes.
- Target dir: `app.path().app_data_dir()/inline_images/` (created if missing).
- Filename: unique, e.g. `pasted-<counter-or-uuid>.<ext>`, where `ext` comes from
  `guess_extension_from_mime(mime_type)` (inverse of the existing
  `guess_mime_from_extension`).
- Write bytes; return
  `OutgoingAttachment { filename, mime_type, blob_ref: <path>, content_id: None }`.
- Validation: `mime_type` must start with `image/`; enforce a size cap (~25 MB) →
  return a readable `Err(String)` otherwise.

### `read_inline_image(blob_ref: String) -> String` (base64)
- Read the file at `blob_ref`, return base64. Frontend composes the `data:` URI
  from the attachment's `mime_type`.
- Path guard: only allow reading files inside `app_data_dir`, so the command cannot
  become an arbitrary file reader.

No DB migration. After adding the commands, regenerate TypeScript bindings
(`src/ipc/bindings`).

## Frontend (React / TipTap) — `Composer.tsx`

- Shared helper `insertInlineImageFromBlob(blob: Blob)`:
  `blob → base64 → dataUri`, `await commands.saveInlineImage`, generate `content_id`,
  atomically `setImage` + `inlineSrcMapRef.set` + `setAttachments`, `scheduleAutosave`.
  Reused by both paste and drop.
- `editorProps` in `useEditor`:
  - `handlePaste(view, event)`: iterate `event.clipboardData.items`; for
    `type.startsWith("image/")` → `getAsFile()` → helper; return `true` only when an
    image was handled (to block the default paste of a path/garbage). No image →
    `false` (normal text paste untouched).
  - `handleDrop(view, event)`: same for `event.dataTransfer.files`.
- Draft preview reconstruction: a new async function invoked after `prefill` loads,
  which for `prefill.attachments` with a `content_id` calls `readInlineImage`,
  rewrites `cid:` → `data:` in `prefill.html_body`, populates `inlineSrcMapRef`, then
  `editor.commands.setContent(...)`.

## Error handling

- `saveInlineImage` returns `Err` (too large / write failure / non-image MIME) →
  helper `catch` surfaces a short message (reusing the composer's error surface); the
  image is not inserted. No silent failure.
- `readInlineImage` failure on draft open (file gone) → skip that image / leave a
  placeholder; the rest of the draft loads normally.
- `handlePaste`/`handleDrop` with no image → `return false` (default editor behaviour
  untouched).

## Testing

- Rust (`compose.rs` already has `inline_image_becomes_related_part_with_content_id`):
  - `save_inline_image`: bytes written, correct `blob_ref`, MIME→extension mapping,
    rejects non-image MIME and over-limit size.
  - `read_inline_image`: round-trip; rejects a path outside `app_data_dir`.
- Frontend (vitest):
  - `rewriteInlineSrcs` rewrites a `data:` URI → `cid:`.
  - The `blob → base64` helper, with `commands.saveInlineImage` mocked, appends an
    attachment and a map entry. Mock `commands` as in the existing composer tests.

## Known limitations (deferred)

- **File cleanup.** On draft `discard`, its inline image files are deleted (safe — no
  pending send). After **send**, files are NOT deleted immediately, because sending is
  asynchronous (`build_message` reads `blob_ref` from disk only at `drain_outbox`);
  deleting would break the send. They remain as a minor leak under
  `app_data/inline_images/`. Follow-up: clean up after `SendSucceeded`.
- Web-copied images arriving as HTML with an `http` URL are out of scope.
