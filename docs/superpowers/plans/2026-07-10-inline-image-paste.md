# Inline Image Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user paste (Ctrl+V) and drag & drop images into the mail body; embed them as `cid:` MIME parts, with drafts surviving app restart.

**Architecture:** Frontend reads the pasted/dropped image `Blob`, converts to base64, and calls a new Rust command that persists the bytes under the app data dir and returns an `OutgoingAttachment`. The editor previews the image as a `data:` URI; the existing `rewriteInlineSrcs` swaps `data:`→`cid:` at send/autosave, and the existing `build_message` already produces `multipart/related`. On draft reopen a second command reads the bytes back and rebuilds the preview.

**Tech Stack:** Rust (Tauri 2, `base64` 0.22, `tauri-specta`), React + TipTap v3, vitest, cargo test.

## Global Constraints

- All code identifiers and strings in English (no other language at code level). No code comments.
- Conventional Commits 1.0.0 for messages. Do not add a co-author trailer. Do not push.
- Embed images as MIME `cid:` parts (`multipart/related`) — reuse existing `build_message`; do NOT change the Rust MIME builder or the sanitizer.
- Inline image bytes persist under `app_data_dir/inline_images/`.
- Size cap for a pasted/dropped image: `25 * 1024 * 1024` bytes.
- No DB migration (the `attachments` table already has `content_id` and `blob_ref`).
- Out of scope: images copied from web pages as HTML `http` URLs; cleanup of inline files after a successful send (accepted leak, deferred follow-up).

---

## File structure

- `crates/am-app/src/commands.rs` — add `guess_extension_from_mime`, `write_inline_image`, `read_inline_image_file`, `delete_inline_files` (pure helpers) and commands `save_inline_image`, `read_inline_image`; extend `discard_draft`. Add Rust tests in the existing `#[cfg(test)] mod tests`.
- `crates/am-app/src/lib.rs` — register `save_inline_image` and `read_inline_image` in `collect_commands!`.
- `src/ipc/bindings.ts` (generated) — regenerated via `npm run gen:bindings`.
- `src/features/composer/inlineImages.ts` — NEW: pure/near-pure helpers (`rewriteInlineSrcs`, `generateContentId`, `blobToDataUrl`, `saveInlineImageAttachment`, `reconstructDraftInlineImages`).
- `src/features/composer/inlineImages.test.ts` — NEW: unit tests for the module.
- `src/features/composer/Composer.tsx` — import helpers from the new module, add `editorProps.handlePaste`/`handleDrop`, `insertInlineImageFromBlob`, and draft-reopen reconstruction effect.

---

## Task 1: Backend — persist & read inline image bytes

**Files:**
- Modify: `crates/am-app/src/commands.rs` (add helpers + commands near `pick_attachment` at `commands.rs:997`; tests in `mod tests` at `commands.rs:1494`)
- Modify: `crates/am-app/src/lib.rs:67` (register commands)
- Regenerate: `src/ipc/bindings.ts`

**Interfaces:**
- Produces (Rust): `fn write_inline_image(dir: &Path, mime_type: &str, bytes: &[u8]) -> Result<OutgoingAttachment, String>`; `fn read_inline_image_file(app_data_dir: &Path, blob_ref: &str) -> Result<String, String>`; `const MAX_INLINE_IMAGE_BYTES: usize`; commands `save_inline_image(app, mime_type: String, data_base64: String) -> Result<OutgoingAttachment, String>`, `read_inline_image(app, blob_ref: String) -> Result<String, String>`.
- Produces (TS, generated): `commands.saveInlineImage(mimeType: string, dataBase64: string): Promise<Result<OutgoingAttachment, string>>`; `commands.readInlineImage(blobRef: string): Promise<Result<string, string>>`.
- Consumes: existing `unique_path(dir, name) -> PathBuf` (`commands.rs`), existing `OutgoingAttachment` (`am_core::OutgoingAttachment`), `base64::engine::general_purpose::STANDARD`.

- [ ] **Step 1: Write the failing Rust tests**

Add to `crates/am-app/src/commands.rs` inside `mod tests` (after the existing `unique_path` test):

```rust
    #[test]
    fn write_inline_image_persists_bytes_and_maps_mime() {
        use std::fs;
        let dir = std::env::temp_dir().join(format!("am-inline-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let att = super::write_inline_image(&dir, "image/png", b"\x89PNG\r\n").unwrap();
        assert_eq!(att.mime_type, "image/png");
        assert!(att.filename.ends_with(".png"));
        assert_eq!(att.content_id, None);
        let written = fs::read(&att.blob_ref).unwrap();
        assert_eq!(written, b"\x89PNG\r\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_inline_image_rejects_non_image_and_oversize() {
        let dir = std::env::temp_dir().join(format!("am-inline-rej-{}", std::process::id()));
        assert!(super::write_inline_image(&dir, "application/pdf", b"x").is_err());
        let big = vec![0u8; super::MAX_INLINE_IMAGE_BYTES + 1];
        assert!(super::write_inline_image(&dir, "image/png", &big).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_inline_image_file_roundtrips_and_guards_path() {
        use base64::Engine;
        use std::fs;
        let base = std::env::temp_dir().join(format!("am-read-{}", std::process::id()));
        let inside = base.join("inline_images");
        fs::create_dir_all(&inside).unwrap();
        let f = inside.join("a.png");
        fs::write(&f, b"hello").unwrap();
        let b64 = super::read_inline_image_file(&base, f.to_str().unwrap()).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(b64).unwrap(),
            b"hello"
        );

        let outside = std::env::temp_dir().join(format!("am-out-{}.png", std::process::id()));
        fs::write(&outside, b"secret").unwrap();
        assert!(super::read_inline_image_file(&base, outside.to_str().unwrap()).is_err());

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_file(&outside);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p abeonmail write_inline_image read_inline_image_file`
Expected: FAIL to compile — `write_inline_image` / `read_inline_image_file` / `MAX_INLINE_IMAGE_BYTES` not found.

- [ ] **Step 3: Add the helpers and commands**

In `crates/am-app/src/commands.rs`, immediately after `guess_mime_from_extension` (ends at `commands.rs:995`) add:

```rust
fn guess_extension_from_mime(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        _ => "bin",
    }
}

const MAX_INLINE_IMAGE_BYTES: usize = 25 * 1024 * 1024;

fn write_inline_image(
    dir: &std::path::Path,
    mime_type: &str,
    bytes: &[u8],
) -> Result<OutgoingAttachment, String> {
    if !mime_type.starts_with("image/") {
        return Err("Only image files can be pasted inline".to_string());
    }
    if bytes.len() > MAX_INLINE_IMAGE_BYTES {
        return Err("Image is too large (max 25 MB)".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create image directory: {e}"))?;
    let ext = guess_extension_from_mime(mime_type);
    let path = unique_path(dir, &format!("pasted-image.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write image: {e}"))?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("pasted-image")
        .to_string();
    Ok(OutgoingAttachment {
        filename,
        mime_type: mime_type.to_string(),
        blob_ref: path.to_string_lossy().into_owned(),
        content_id: None,
    })
}

fn read_inline_image_file(app_data_dir: &std::path::Path, blob_ref: &str) -> Result<String, String> {
    use base64::Engine;
    let canonical = std::fs::canonicalize(blob_ref).map_err(|_| "Image not found".to_string())?;
    let base =
        std::fs::canonicalize(app_data_dir).map_err(|_| "Cannot resolve app data dir".to_string())?;
    if !canonical.starts_with(&base) {
        return Err("Refusing to read file outside app data".to_string());
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("Failed to read image: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
#[specta::specta]
pub fn save_inline_image(
    app: tauri::AppHandle,
    mime_type: String,
    data_base64: String,
) -> Result<OutgoingAttachment, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "Invalid image data".to_string())?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve app data dir".to_string())?
        .join("inline_images");
    write_inline_image(&dir, &mime_type, &bytes)
}

#[tauri::command]
#[specta::specta]
pub fn read_inline_image(app: tauri::AppHandle, blob_ref: String) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve app data dir".to_string())?;
    read_inline_image_file(&base, &blob_ref)
}
```

- [ ] **Step 4: Register the commands**

In `crates/am-app/src/lib.rs`, after `commands::pick_attachment,` (`lib.rs:67`) add two lines:

```rust
            commands::pick_attachment,
            commands::save_inline_image,
            commands::read_inline_image,
```

- [ ] **Step 5: Run the Rust tests to verify they pass**

Run: `cargo test -p abeonmail write_inline_image read_inline_image_file`
Expected: PASS (3 tests).

- [ ] **Step 6: Regenerate TypeScript bindings**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` now contains `saveInlineImage` and `readInlineImage`. Verify:

Run: `grep -n "saveInlineImage\|readInlineImage" src/ipc/bindings.ts`
Expected: both names present.

- [ ] **Step 7: Commit**

```bash
git add crates/am-app/src/commands.rs crates/am-app/src/lib.rs src/ipc/bindings.ts
git commit -m "feat(composer): backend commands to persist and read inline images"
```

---

## Task 2: Frontend — inline image helper module

**Files:**
- Create: `src/features/composer/inlineImages.ts`
- Test: `src/features/composer/inlineImages.test.ts`

**Interfaces:**
- Consumes: `OutgoingAttachment` from `../../ipc/bindings`; `commands.saveInlineImage`/`commands.readInlineImage` (passed in as function args, not imported, for testability).
- Produces: `rewriteInlineSrcs(html, map)`, `generateContentId()`, `blobToDataUrl(blob)`, `saveInlineImageAttachment(blob, saveInlineImage)`, `reconstructDraftInlineImages(html, attachments, readInlineImage)`, `interface InlineImageInsert`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/composer/inlineImages.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  rewriteInlineSrcs,
  saveInlineImageAttachment,
  reconstructDraftInlineImages,
} from "./inlineImages";

describe("rewriteInlineSrcs", () => {
  it("rewrites a mapped data URI to a cid", () => {
    const map = new Map([["data:image/png;base64,AAA", "inline-1@abeonmail"]]);
    const html = '<p><img src="data:image/png;base64,AAA"></p>';
    expect(rewriteInlineSrcs(html, map)).toBe('<p><img src="cid:inline-1@abeonmail"></p>');
  });

  it("leaves unmapped srcs unchanged", () => {
    const html = '<img src="https://example.com/a.png">';
    expect(rewriteInlineSrcs(html, new Map())).toBe(html);
  });
});

describe("saveInlineImageAttachment", () => {
  it("saves the blob and returns an attachment carrying the generated content id", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const saveInlineImage = vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        filename: "pasted-image.png",
        mime_type: "image/png",
        blob_ref: "/data/inline_images/pasted-image.png",
        content_id: null,
      },
    });
    const res = await saveInlineImageAttachment(blob, saveInlineImage);
    expect(saveInlineImage).toHaveBeenCalledWith("image/png", expect.any(String));
    expect(res.attachment.content_id).toBe(res.contentId);
    expect(res.dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("throws when the backend rejects the image", async () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const saveInlineImage = vi
      .fn()
      .mockResolvedValue({ status: "error", error: "Image is too large (max 25 MB)" });
    await expect(saveInlineImageAttachment(blob, saveInlineImage)).rejects.toThrow("too large");
  });
});

describe("reconstructDraftInlineImages", () => {
  it("replaces cid refs with data URIs and returns map entries", async () => {
    const html = '<p><img src="cid:inline-1@abeonmail"></p>';
    const attachments = [
      {
        filename: "a.png",
        mime_type: "image/png",
        blob_ref: "/data/inline_images/a.png",
        content_id: "inline-1@abeonmail",
      },
    ];
    const readInlineImage = vi.fn().mockResolvedValue({ status: "ok", data: "QUFB" });
    const { html: out, entries } = await reconstructDraftInlineImages(
      html,
      attachments,
      readInlineImage,
    );
    expect(out).toBe('<p><img src="data:image/png;base64,QUFB"></p>');
    expect(entries).toEqual([["data:image/png;base64,QUFB", "inline-1@abeonmail"]]);
  });

  it("skips attachments the backend cannot read", async () => {
    const html = '<img src="cid:inline-9@abeonmail">';
    const attachments = [
      {
        filename: "x.png",
        mime_type: "image/png",
        blob_ref: "/outside/x.png",
        content_id: "inline-9@abeonmail",
      },
    ];
    const readInlineImage = vi.fn().mockResolvedValue({ status: "error", error: "not found" });
    const { html: out, entries } = await reconstructDraftInlineImages(
      html,
      attachments,
      readInlineImage,
    );
    expect(out).toBe(html);
    expect(entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/composer/inlineImages.test.ts`
Expected: FAIL — module `./inlineImages` not found.

- [ ] **Step 3: Implement the module**

Create `src/features/composer/inlineImages.ts`:

```ts
import type { OutgoingAttachment } from "../../ipc/bindings";

type CommandResult<T> = { status: "ok"; data: T } | { status: "error"; error: string };

let inlineImageCounter = 0;

export function generateContentId(): string {
  inlineImageCounter += 1;
  return `inline-${inlineImageCounter}@abeonmail`;
}

export function rewriteInlineSrcs(html: string, srcToContentId: Map<string, string>): string {
  return html.replace(/<img([^>]*)\ssrc="([^"]*)"([^>]*)>/g, (match, before, src, after) => {
    const contentId = srcToContentId.get(src);
    if (contentId) {
      return `<img${before} src="cid:${contentId}"${after}>`;
    }
    return match;
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}

export interface InlineImageInsert {
  dataUri: string;
  contentId: string;
  attachment: OutgoingAttachment;
}

export async function saveInlineImageAttachment(
  blob: Blob,
  saveInlineImage: (
    mimeType: string,
    dataBase64: string,
  ) => Promise<CommandResult<OutgoingAttachment>>,
): Promise<InlineImageInsert> {
  const dataUri = await blobToDataUrl(blob);
  const base64 = dataUri.split(",")[1] ?? "";
  const mimeType = blob.type || "image/png";
  const result = await saveInlineImage(mimeType, base64);
  if (result.status !== "ok") {
    throw new Error(result.error);
  }
  const contentId = generateContentId();
  return { dataUri, contentId, attachment: { ...result.data, content_id: contentId } };
}

export async function reconstructDraftInlineImages(
  html: string,
  attachments: OutgoingAttachment[],
  readInlineImage: (blobRef: string) => Promise<CommandResult<string>>,
): Promise<{ html: string; entries: Array<[string, string]> }> {
  let out = html;
  const entries: Array<[string, string]> = [];
  for (const att of attachments) {
    if (!att.content_id || !att.blob_ref) continue;
    const result = await readInlineImage(att.blob_ref);
    if (result.status !== "ok") continue;
    const dataUri = `data:${att.mime_type};base64,${result.data}`;
    out = out.split(`cid:${att.content_id}`).join(dataUri);
    entries.push([dataUri, att.content_id]);
  }
  return { html: out, entries };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/composer/inlineImages.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/inlineImages.ts src/features/composer/inlineImages.test.ts
git commit -m "feat(composer): inline image helper module with tests"
```

---

## Task 3: Frontend — wire paste, drop, and draft reconstruction into the composer

**Files:**
- Modify: `src/features/composer/Composer.tsx`

**Interfaces:**
- Consumes: `rewriteInlineSrcs`, `generateContentId`, `saveInlineImageAttachment`, `reconstructDraftInlineImages` from `./inlineImages`; `commands.saveInlineImage`, `commands.readInlineImage`.
- Produces: no exports; behaviour — paste/drop insert inline images, drafts with inline images rebuild their preview on open.

- [ ] **Step 1: Replace the local helpers with imports from the module**

In `src/features/composer/Composer.tsx`, delete the local `inlineImageCounter`, `generateContentId`, and `rewriteInlineSrcs` definitions (`Composer.tsx:15-30`). Add to the imports at the top of the file (after the existing `./editor/extensions` import at `Composer.tsx:3`):

```ts
import {
  rewriteInlineSrcs,
  generateContentId,
  saveInlineImageAttachment,
  reconstructDraftInlineImages,
} from "./inlineImages";
```

- [ ] **Step 2: Declare the insert-handler ref before `useEditor` and add `editorProps`**

Immediately before `const editor = useEditor({` (`Composer.tsx:78`) add:

```ts
  const insertInlineImageRef = useRef<(blob: Blob) => void>(() => {});
```

Replace the `useEditor({ ... })` call (`Composer.tsx:78-81`) with:

```ts
  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: buildInitialContent(prefill?.html_body, composer.draftId == null),
    editorProps: {
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              insertInlineImageRef.current(file);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        let handled = false;
        for (const file of Array.from(files)) {
          if (file.type.startsWith("image/")) {
            insertInlineImageRef.current(file);
            handled = true;
          }
        }
        return handled;
      },
    },
  });
```

- [ ] **Step 3: Add the insert handler and keep the ref current**

After `handleInsertImage` (ends at `Composer.tsx:248`) add:

```ts
  const insertInlineImageFromBlob = useCallback(
    async (blob: Blob) => {
      if (!editor) return;
      try {
        const { dataUri, contentId, attachment } = await saveInlineImageAttachment(
          blob,
          commands.saveInlineImage,
        );
        inlineSrcMapRef.current.set(dataUri, contentId);
        editor.chain().focus().setImage({ src: dataUri }).run();
        setAttachments((prev) => [...prev, attachment]);
        scheduleAutosave();
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
      }
    },
    [editor, scheduleAutosave],
  );

  insertInlineImageRef.current = insertInlineImageFromBlob;
```

- [ ] **Step 4: Reconstruct inline previews when reopening a draft**

Replace the existing prefill effect (`Composer.tsx:83-90`) with a guarded version plus a reconstruction effect:

```ts
  useEffect(() => {
    if (prefill?.html_body && editor) {
      const hasInline = (prefill.attachments ?? []).some((a) => a.content_id);
      if (hasInline && composer.draftId != null) return;
      editor.commands.setContent(buildInitialContent(prefill.html_body, composer.draftId == null));
      if (composer.draftId == null) {
        editor.commands.focus("start");
      }
    }
  }, [prefill?.html_body, prefill?.attachments, editor, composer.draftId]);

  const inlineReconstructedRef = useRef(false);
  useEffect(() => {
    if (!editor || inlineReconstructedRef.current) return;
    if (composer.draftId == null) return;
    const html = prefill?.html_body;
    const atts = prefill?.attachments ?? [];
    if (!html || !atts.some((a) => a.content_id)) return;
    inlineReconstructedRef.current = true;
    let cancelled = false;
    reconstructDraftInlineImages(html, atts, commands.readInlineImage).then(
      ({ html: rebuilt, entries }) => {
        if (cancelled || !editor) return;
        for (const [src, cid] of entries) {
          inlineSrcMapRef.current.set(src, cid);
        }
        editor.commands.setContent(rebuilt);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [editor, composer.draftId, prefill?.html_body, prefill?.attachments]);
```

- [ ] **Step 5: Typecheck and run the composer test suite**

Run: `npx tsc --noEmit`
Expected: no errors (note: `generateContentId` is now imported and still used by `handleInsertImage`).

Run: `npx vitest run src/features/composer/Composer.test.tsx`
Expected: PASS (no regressions; the existing mock `useEditor` ignores `editorProps`).

- [ ] **Step 6: Commit**

```bash
git add src/features/composer/Composer.tsx
git commit -m "feat(composer): paste and drag-drop images into the mail body"
```

---

## Task 4: Backend — delete inline files when a draft is discarded

**Files:**
- Modify: `crates/am-app/src/commands.rs` (`discard_draft` at `commands.rs:899-907`; add `delete_inline_files` helper; test in `mod tests`)

**Interfaces:**
- Consumes: `drafts_repo::get_draft`, `drafts_repo::delete_draft`, `am_core::OutgoingAttachment`, `app.path().app_data_dir()`.
- Produces: `fn delete_inline_files(inline_dir: &Path, attachments: &[OutgoingAttachment])`; `discard_draft` gains an `app: tauri::AppHandle` parameter (TS signature `discardDraft(draftId)` unchanged — `app`/`state` are injected, so no bindings regeneration).

- [ ] **Step 1: Write the failing test**

Add to `crates/am-app/src/commands.rs` inside `mod tests`:

```rust
    #[test]
    fn delete_inline_files_removes_only_inline_attachments() {
        use std::fs;
        let dir = std::env::temp_dir().join(format!("am-del-{}", std::process::id()));
        let inline = dir.join("inline_images");
        fs::create_dir_all(&inline).unwrap();
        let inline_file = inline.join("a.png");
        fs::write(&inline_file, b"x").unwrap();
        let other = dir.join("keep.pdf");
        fs::write(&other, b"x").unwrap();
        let atts = vec![
            am_core::OutgoingAttachment {
                filename: "a.png".into(),
                mime_type: "image/png".into(),
                blob_ref: inline_file.to_string_lossy().into_owned(),
                content_id: Some("c1".into()),
            },
            am_core::OutgoingAttachment {
                filename: "keep.pdf".into(),
                mime_type: "application/pdf".into(),
                blob_ref: other.to_string_lossy().into_owned(),
                content_id: None,
            },
        ];
        super::delete_inline_files(&inline, &atts);
        assert!(!inline_file.exists());
        assert!(other.exists());
        let _ = fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p abeonmail delete_inline_files`
Expected: FAIL to compile — `delete_inline_files` not found.

- [ ] **Step 3: Implement the helper and extend `discard_draft`**

Add the helper next to the other inline helpers in `crates/am-app/src/commands.rs`:

```rust
fn delete_inline_files(inline_dir: &std::path::Path, attachments: &[OutgoingAttachment]) {
    for att in attachments {
        if att.content_id.is_none() {
            continue;
        }
        let path = std::path::Path::new(&att.blob_ref);
        if path.starts_with(inline_dir) {
            let _ = std::fs::remove_file(path);
        }
    }
}
```

Replace `discard_draft` (`commands.rs:899-907`) with:

```rust
#[tauri::command]
#[specta::specta]
pub fn discard_draft(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    draft_id: i64,
) -> Result<(), String> {
    if let Ok(dir) = app.path().app_data_dir() {
        let inline_dir = dir.join("inline_images");
        if let Ok((_account_id, msg)) = drafts_repo::get_draft(&state.db, draft_id) {
            delete_inline_files(&inline_dir, &msg.attachments);
        }
    }
    drafts_repo::delete_draft(&state.db, draft_id)
        .map_err(|_| "Failed to discard draft".to_string())
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p abeonmail delete_inline_files`
Expected: PASS.

- [ ] **Step 5: Verify TS bindings are unchanged**

Run: `npm run gen:bindings && git diff --stat src/ipc/bindings.ts`
Expected: no change to `src/ipc/bindings.ts` (`discardDraft(draftId)` signature unaffected).

- [ ] **Step 6: Commit**

```bash
git add crates/am-app/src/commands.rs
git commit -m "feat(composer): remove inline image files when a draft is discarded"
```

---

## Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full Rust test suite**

Run: `cargo test -p abeonmail`
Expected: PASS (including the 4 new tests).

- [ ] **Step 2: Run the full frontend test suite**

Run: `npx vitest run`
Expected: no new failures beyond the documented pre-existing ones (ConversationView reply-button, useDebouncedValue fake-timers, store.test sending-counter).

- [ ] **Step 3: Manual smoke test in the running app**

Run the app (`npm run tauri dev`), open the composer, then:
- Copy a screenshot to the clipboard and press Ctrl+V in the body → the image appears inline.
- Drag an image file onto the body → the image appears inline.
- Send to yourself → the received mail shows the image (embedded as a `cid:` part).
- Paste an image, close the composer to save the draft, reopen the draft → the image still renders.
- Discard a draft that had a pasted image → its file under `app_data/inline_images/` is gone.

Expected: all five behave as described.

---

## Notes for the implementer

- Do NOT change `crates/am-mime/src/compose.rs` or `crates/am-mime/src/sanitize.rs`. Inline `cid:` embedding and `data:image/*`/`cid:` allow-listing already exist there; the new code reuses them.
- The existing `handleInsertImage` (file-picker inline insert) is intentionally left unchanged. Its preview uses a raw file path and its picked files live outside `app_data`, so `reconstructDraftInlineImages` will skip them on reopen (guarded by the path check). That is a pre-existing limitation, not a regression from this work.
- After a successful send, inline files are intentionally NOT deleted (the async send reads them from disk at drain time). This is the documented deferred follow-up: clean up after `SendSucceeded`.
