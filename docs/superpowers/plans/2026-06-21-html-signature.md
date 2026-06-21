# HTML Signature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to author a signature as raw HTML (tables, inline CSS, logo) that is preserved verbatim end-to-end, instead of only through the limited TipTap WYSIWYG editor.

**Architecture:** Add an `is_html` flag to signatures. In Settings, a mode toggle lets the user edit raw HTML in a textarea (bypassing TipTap). In the Composer, raw-HTML signatures are NOT injected into TipTap (which would strip them); instead they render in a sandboxed `SafeHtmlFrame` preview and are appended verbatim to `html_body` only at send time. The send-path sanitizer already preserves email-safe HTML, so no backend send changes are needed.

**Tech Stack:** Rust (rusqlite, refinery migrations, specta), Tauri commands, TypeScript, React 19, TanStack Query, TipTap, Vitest.

## Global Constraints

- All code identifiers (variables, constants, functions, types) MUST be in English.
- No code comments. If something is important, it belongs in `docs/`.
- Conventional Commits 1.0.0 for commit messages. Match existing scope style, e.g. `feat(signatures): …`.
- Do NOT add a Co-Authored-By trailer.
- Do NOT push. Only commit locally.
- Work happens on branch `feat/html-signature` (already created).
- Frontend npm/vitest commands require Node 24 — run `nvm use` first if the active Node is older (see memory: node-version-vite-crypto-hash).
- `is_html` is the new field name everywhere (Rust `is_html`, TS binding `is_html`, query hook param `isHtml`).
- New command param order: `create_signature(account_id, name, html, make_default, is_html)`, `update_signature(id, name, html, is_html)` — `is_html` is appended LAST so generated binding args stay backward-friendly.

---

### Task 1: Backend — `is_html` column, struct, repo, commands

**Files:**
- Create: `crates/am-storage/src/migrations/V14__signature_is_html.sql`
- Modify: `crates/am-core/src/signature.rs`
- Modify: `crates/am-storage/src/signatures_repo.rs`
- Modify: `crates/am-app/src/commands.rs:720-743`
- Test: `crates/am-storage/src/signatures_repo.rs` (tests mod), `crates/am-storage/src/db.rs` (tests mod)

**Interfaces:**
- Produces (Rust):
  - `am_core::signature::Signature { id: i64, name: String, html: String, is_default: bool, is_html: bool }`
  - `signatures_repo::create_signature(db, account_id: i64, name: &str, html: &str, make_default: bool, is_html: bool) -> Result<Signature, StorageError>`
  - `signatures_repo::update_signature(db, id: i64, name: &str, html: &str, is_html: bool) -> Result<(), StorageError>`
  - `signatures_repo::list_signatures(db, account_id: i64) -> Result<Vec<Signature>, StorageError>` (now returns `is_html`)

- [ ] **Step 1: Write the migration**

Create `crates/am-storage/src/migrations/V14__signature_is_html.sql`:

```sql
ALTER TABLE signatures ADD COLUMN is_html INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Write the failing migration test**

In `crates/am-storage/src/db.rs`, inside the existing `#[cfg(test)] mod tests`, add:

```rust
#[test]
fn migration_v14_adds_is_html_column() {
    let db = Database::open_in_memory().unwrap();
    let conn = db.conn();
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('signatures') WHERE name='is_html'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
```

- [ ] **Step 3: Run the migration test to verify it fails**

Run: `cargo test -p am-storage migration_v14_adds_is_html_column`
Expected: FAIL (column `is_html` does not exist) — actually this will PASS once the SQL file from Step 1 is present, because refinery auto-embeds it. If it already passes, that confirms the migration is wired; proceed. (Refinery `embed_migrations!("src/migrations")` picks up the new file at compile time.)

- [ ] **Step 4: Add `is_html` to the `Signature` struct**

Replace the body of `crates/am-core/src/signature.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Signature {
    pub id: i64,
    pub name: String,
    pub html: String,
    pub is_default: bool,
    pub is_html: bool,
}
```

- [ ] **Step 5: Update `list_signatures` to read `is_html`**

In `crates/am-storage/src/signatures_repo.rs`, replace the `list_signatures` body:

```rust
pub fn list_signatures(db: &Database, account_id: i64) -> Result<Vec<Signature>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, name, html, is_default, is_html FROM signatures WHERE account_id=?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |r| {
        Ok(Signature {
            id: r.get(0)?,
            name: r.get(1)?,
            html: r.get(2)?,
            is_default: r.get::<_, i64>(3)? != 0,
            is_html: r.get::<_, i64>(4)? != 0,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
```

- [ ] **Step 6: Update `create_signature` to accept and store `is_html`**

Replace the `create_signature` function:

```rust
pub fn create_signature(
    db: &Database,
    account_id: i64,
    name: &str,
    html: &str,
    make_default: bool,
    is_html: bool,
) -> Result<Signature, StorageError> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let existing: i64 = tx.query_row(
        "SELECT COUNT(*) FROM signatures WHERE account_id = ?1",
        params![account_id],
        |r| r.get(0),
    )?;
    let is_default = make_default || existing == 0;
    if is_default {
        tx.execute(
            "UPDATE signatures SET is_default = 0 WHERE account_id = ?1",
            params![account_id],
        )?;
    }
    tx.execute(
        "INSERT INTO signatures (account_id, name, html, is_default, is_html) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![account_id, name, html, is_default as i64, is_html as i64],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(Signature {
        id,
        name: name.to_string(),
        html: html.to_string(),
        is_default,
        is_html,
    })
}
```

- [ ] **Step 7: Update `update_signature` to accept and store `is_html`**

Replace the `update_signature` function:

```rust
pub fn update_signature(
    db: &Database,
    id: i64,
    name: &str,
    html: &str,
    is_html: bool,
) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE signatures SET name = ?2, html = ?3, is_html = ?4 WHERE id = ?1",
        params![id, name, html, is_html as i64],
    )?;
    Ok(())
}
```

- [ ] **Step 8: Fix existing repo test call sites and add `is_html` round-trip tests**

In `crates/am-storage/src/signatures_repo.rs` tests mod, every existing `create_signature(&db, account_id, "X", "<p>…</p>", <bool>)` call now needs a 6th arg `false`, and the single `update_signature(&db, sig.id, "Job", "<p>new</p>")` call needs a 5th arg `false`. Update them:

- `create_first_signature_becomes_default`: `create_signature(&db, account_id, "Work", "<p>BR</p>", false, false)`
- `create_with_make_default_unsets_previous_default`: both calls gain `, false` → `(…, "<p>1</p>", false, false)` and `(…, "<p>2</p>", true, false)`
- `create_non_default_keeps_existing_default`: both gain `, false`
- `update_signature_changes_name_and_html`: create gains `, false`; `update_signature(&db, sig.id, "Job", "<p>new</p>", false)`
- `set_default_switches_between_signatures`: both creates gain `, false`
- `delete_default_promotes_min_id`: `(…,"<p>1</p>", false, false)` and `(…,"<p>2</p>", true, false)`
- `delete_non_default_keeps_default`: both creates gain `, false`
- `signatures_are_isolated_per_account`: both creates gain `, false`

Then add these new tests to the same tests mod:

```rust
#[test]
fn create_signature_defaults_is_html_false_via_insert() {
    let db = Database::open_in_memory().unwrap();
    let account_id = acct(&db);
    let sig = create_signature(&db, account_id, "Plain", "<p>BR</p>", false, false).unwrap();
    assert!(!sig.is_html);
    let listed = list_signatures(&db, account_id).unwrap();
    assert!(!listed[0].is_html);
}

#[test]
fn create_html_signature_persists_is_html() {
    let db = Database::open_in_memory().unwrap();
    let account_id = acct(&db);
    let sig = create_signature(
        &db,
        account_id,
        "HtmlSig",
        "<table><tr><td>Hi</td></tr></table>",
        false,
        true,
    )
    .unwrap();
    assert!(sig.is_html);
    let listed = list_signatures(&db, account_id).unwrap();
    assert!(listed[0].is_html);
    assert_eq!(listed[0].html, "<table><tr><td>Hi</td></tr></table>");
}

#[test]
fn update_signature_can_set_is_html() {
    let db = Database::open_in_memory().unwrap();
    let account_id = acct(&db);
    let sig = create_signature(&db, account_id, "Work", "<p>old</p>", false, false).unwrap();
    update_signature(&db, sig.id, "Work", "<div style=\"color:red\">x</div>", true).unwrap();
    let listed = list_signatures(&db, account_id).unwrap();
    assert!(listed[0].is_html);
    assert_eq!(listed[0].html, "<div style=\"color:red\">x</div>");
}
```

Also fix the raw-SQL INSERT in `list_signatures_returns_inserted_row` — it inserts into explicit columns `(account_id, name, html, is_default)`, which is still valid (the new column defaults to 0), so no change needed there.

- [ ] **Step 9: Update the Tauri commands**

In `crates/am-app/src/commands.rs`, replace `create_signature` and `update_signature` commands (lines ~720-743):

```rust
#[tauri::command]
#[specta::specta]
pub fn create_signature(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    name: String,
    html: String,
    make_default: bool,
    is_html: bool,
) -> Result<Signature, String> {
    signatures_repo::create_signature(&state.db, account_id, &name, &html, make_default, is_html)
        .map_err(|_| "Failed to create signature".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_signature(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    html: String,
    is_html: bool,
) -> Result<(), String> {
    signatures_repo::update_signature(&state.db, id, &name, &html, is_html)
        .map_err(|_| "Failed to update signature".to_string())
}
```

- [ ] **Step 10: Run the full backend test + build**

Run: `cargo test -p am-storage && cargo build -p abeonmail`
Expected: all `am-storage` tests PASS (including `migration_v14_adds_is_html_column`, `create_html_signature_persists_is_html`, `update_signature_can_set_is_html`); the app crate compiles with the new command signatures.

- [ ] **Step 11: Commit**

```bash
git add crates/am-core/src/signature.rs crates/am-storage/src/migrations/V14__signature_is_html.sql crates/am-storage/src/signatures_repo.rs crates/am-storage/src/db.rs crates/am-app/src/commands.rs
git commit -m "feat(signatures): add is_html flag to signature storage and commands"
```

---

### Task 2: Regenerate bindings and update query hooks

**Files:**
- Modify (generated): `src/ipc/bindings.ts`
- Modify: `src/ipc/queries.ts:512-549`

**Interfaces:**
- Consumes: Task 1's `Signature` (now with `is_html`) and command signatures.
- Produces (TS):
  - `Signature` type gains `is_html: boolean`.
  - `commands.createSignature(accountId, name, html, makeDefault, isHtml)`.
  - `commands.updateSignature(id, name, html, isHtml)`.
  - `useCreateSignature().mutate({ accountId, name, html, makeDefault, isHtml })`.
  - `useUpdateSignature().mutate({ id, name, html, accountId, isHtml })`.

- [ ] **Step 1: Regenerate bindings**

Run: `npm run gen:bindings`
Expected: `src/ipc/bindings.ts` updates so the `Signature` type includes `is_html: boolean` and `createSignature`/`updateSignature` gain the `isHtml`/`is_html` parameter. Verify with:

Run: `grep -n "is_html" src/ipc/bindings.ts`
Expected: at least one hit in the `Signature` type and the command arg list.

- [ ] **Step 2: Update `useCreateSignature`**

In `src/ipc/queries.ts`, replace `useCreateSignature`:

```ts
export function useCreateSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      accountId,
      name,
      html,
      makeDefault,
      isHtml,
    }: {
      accountId: number;
      name: string;
      html: string;
      makeDefault: boolean;
      isHtml: boolean;
    }) => commands.createSignature(accountId, name, html, makeDefault, isHtml).then(unwrap),
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ["signatures", accountId] });
    },
  });
}
```

- [ ] **Step 3: Update `useUpdateSignature`**

Replace `useUpdateSignature`:

```ts
export function useUpdateSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      name,
      html,
      isHtml,
    }: {
      id: number;
      name: string;
      html: string;
      accountId: number;
      isHtml: boolean;
    }) => commands.updateSignature(id, name, html, isHtml).then(unwrap),
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ["signatures", accountId] });
    },
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS for `queries.ts`. NOTE: `SignaturesSection.tsx` and `Composer.tsx` are NOT yet updated and may now report type errors because `Signature` requires `is_html` and the mutate calls lack `isHtml`. That is expected — those are fixed in Tasks 3 and 4. If `tsc` errors ONLY in those two files plus their tests, proceed. If it errors anywhere else, fix that before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/bindings.ts src/ipc/queries.ts
git commit -m "feat(signatures): regenerate bindings and pass is_html through query hooks"
```

---

### Task 3: Settings — raw HTML edit mode

**Files:**
- Modify: `src/features/reader/SafeHtmlFrame.tsx`
- Modify: `src/features/settings/SignaturesSection.tsx`
- Modify: `src/features/settings/Settings.css`
- Test: `src/features/settings/SignaturesSection.test.tsx`

**Interfaces:**
- Consumes: `useCreateSignature`/`useUpdateSignature` (with `isHtml`), `Signature.is_html`.
- Produces:
  - `SafeHtmlFrame({ html, title?, className? })` — optional `title` (default `"message-content"`) and `className` (default `"reader-frame"`).

- [ ] **Step 1: Make `SafeHtmlFrame` reusable (optional title + className)**

Replace `src/features/reader/SafeHtmlFrame.tsx`:

```tsx
export function SafeHtmlFrame({
  html,
  title = "message-content",
  className = "reader-frame",
}: {
  html: string;
  title?: string;
  className?: string;
}) {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html}
      className={className}
    />
  );
}
```

- [ ] **Step 2: Run existing SafeHtmlFrame tests to confirm no regression**

Run: `npx vitest run src/features/reader/SafeHtmlFrame.test.tsx`
Expected: PASS (defaults preserve prior behavior).

- [ ] **Step 3: Write the failing Settings tests**

In `src/features/settings/SignaturesSection.test.tsx`:

(a) Update the existing assertion in `it("creates a new signature", …)` to include the new arg:

```ts
await waitFor(() =>
  expect(commands.createSignature).toHaveBeenCalledWith(7, "Holiday", "<p>edited</p>", false, false),
);
```

(b) Add two new tests inside the `describe`:

```ts
it("saves a raw HTML signature with is_html=true", async () => {
  const { getByText, getByLabelText } = wrap(<SignaturesSection />);
  await waitFor(() => expect(getByText("Work")).toBeTruthy());
  fireEvent.click(getByText("New signature"));
  fireEvent.change(getByLabelText("Signature name"), { target: { value: "HtmlSig" } });
  fireEvent.click(getByText("Edit HTML source"));
  fireEvent.change(getByLabelText("Signature HTML source"), {
    target: { value: "<table><tr><td>Hi</td></tr></table>" },
  });
  fireEvent.click(getByText("Save signature"));
  await waitFor(() =>
    expect(commands.createSignature).toHaveBeenCalledWith(
      7,
      "HtmlSig",
      "<table><tr><td>Hi</td></tr></table>",
      false,
      true,
    ),
  );
});

it("opens an existing HTML signature in HTML source mode", async () => {
  (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: "ok",
    data: [{ id: 5, name: "Fancy", html: "<table>FANCY</table>", is_default: true, is_html: true }],
  });
  const { getByText, getByLabelText } = wrap(<SignaturesSection />);
  await waitFor(() => expect(getByText("Fancy")).toBeTruthy());
  fireEvent.click(getByText("Fancy"));
  const textarea = getByLabelText("Signature HTML source") as HTMLTextAreaElement;
  expect(textarea.value).toBe("<table>FANCY</table>");
});
```

Also add `is_html: false` to the two default mock entries (`Work`, `Casual`) in the top-level `vi.mock` `listSignatures` data so they match the typed shape:

```ts
data: [
  { id: 1, name: "Work", html: "<p>BR</p>", is_default: true, is_html: false },
  { id: 2, name: "Casual", html: "<p>Cheers</p>", is_default: false, is_html: false },
],
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `npx vitest run src/features/settings/SignaturesSection.test.tsx`
Expected: FAIL — "Edit HTML source" button and "Signature HTML source" textarea don't exist yet; createSignature called with 4 args.

- [ ] **Step 5: Implement the Settings raw HTML mode**

Replace `src/features/settings/SignaturesSection.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Trash2 } from "lucide-react";
import { SafeHtmlFrame } from "../reader/SafeHtmlFrame";
import {
  useAccounts,
  useSignatures,
  useCreateSignature,
  useUpdateSignature,
  useSetDefaultSignature,
  useDeleteSignature,
} from "../../ipc/queries";

type EditMode = "visual" | "html";

export function SignaturesSection() {
  const { data: accounts = [] } = useAccounts();
  const [chosenAccountId, setChosenAccountId] = useState<number | null>(null);
  const accountId = chosenAccountId ?? accounts[0]?.id ?? null;

  const { data: signatures = [] } = useSignatures(accountId);
  const createSignature = useCreateSignature();
  const updateSignature = useUpdateSignature();
  const setDefaultSignature = useSetDefaultSignature();
  const deleteSignature = useDeleteSignature();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<EditMode>("visual");
  const [htmlSource, setHtmlSource] = useState("");
  const editor = useEditor({ extensions: [StarterKit], content: "" });

  useEffect(() => {
    setSelectedId(null);
    setName("");
    setMode("visual");
    setHtmlSource("");
    editor?.commands.setContent("<p></p>");
  }, [accountId, editor]);

  function selectSignature(id: number, sigName: string, html: string, isHtml: boolean) {
    setSelectedId(id);
    setName(sigName);
    if (isHtml) {
      setMode("html");
      setHtmlSource(html);
    } else {
      setMode("visual");
      editor?.commands.setContent(html);
    }
  }

  function startNew() {
    setSelectedId(null);
    setName("");
    setMode("visual");
    setHtmlSource("");
    editor?.commands.setContent("<p></p>");
  }

  function toggleMode() {
    if (mode === "visual") {
      setHtmlSource(editor?.getHTML() ?? "");
      setMode("html");
    } else {
      editor?.commands.setContent(htmlSource || "<p></p>");
      setMode("visual");
    }
  }

  function save() {
    if (accountId == null) return;
    const isHtml = mode === "html";
    const html = isHtml ? htmlSource : editor?.getHTML() ?? "<p></p>";
    const trimmed = name.trim() || "Signature";
    if (selectedId == null) {
      createSignature.mutate({ accountId, name: trimmed, html, makeDefault: signatures.length === 0, isHtml });
    } else {
      updateSignature.mutate({ id: selectedId, name: trimmed, html, accountId, isHtml });
    }
  }

  function remove(id: number) {
    if (accountId == null) return;
    deleteSignature.mutate({ id, accountId });
    if (selectedId === id) startNew();
  }

  return (
    <div className="settings-section">
      <label className="settings-account">
        <span className="settings-account__label">Account</span>
        <select
          className="settings-select"
          aria-label="Signatures account"
          value={accountId ?? ""}
          onChange={(e) => setChosenAccountId(Number(e.target.value))}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </label>

      <ul className="signatures-settings__list">
        {signatures.map((sig) => (
          <li key={sig.id} className="signatures-settings__row">
            <button
              type="button"
              className="signatures-settings__name"
              onClick={() => selectSignature(sig.id, sig.name, sig.html, sig.is_html)}
            >
              {sig.name}
            </button>
            <label className="signatures-settings__default">
              <input
                type="radio"
                name="default-signature"
                aria-label={`Set ${sig.name} as default`}
                checked={sig.is_default}
                onChange={() => setDefaultSignature.mutate({ accountId: accountId!, id: sig.id })}
              />
              Default
            </label>
            <button
              type="button"
              className="settings-btn settings-btn--icon"
              aria-label={`Delete signature ${sig.name}`}
              onClick={() => remove(sig.id)}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>

      <div className="signatures-settings__editor">
        <input
          type="text"
          className="settings-input"
          aria-label="Signature name"
          placeholder="Signature name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="settings-btn"
          aria-pressed={mode === "html"}
          onClick={toggleMode}
        >
          {mode === "html" ? "Visual editor" : "Edit HTML source"}
        </button>
        {mode === "html" ? (
          <>
            <textarea
              className="settings-input signatures-settings__html"
              aria-label="Signature HTML source"
              value={htmlSource}
              onChange={(e) => setHtmlSource(e.target.value)}
            />
            <div className="signatures-settings__preview">
              <SafeHtmlFrame html={htmlSource} title="signature-preview" className="signature-preview-frame" />
            </div>
          </>
        ) : (
          <EditorContent editor={editor} className="signatures-settings__body" />
        )}
        <div className="signatures-settings__actions">
          <button type="button" className="settings-btn" onClick={startNew}>
            New signature
          </button>
          <button type="button" className="settings-btn settings-btn--primary" onClick={save}>
            Save signature
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the Settings tests to verify they pass**

Run: `npx vitest run src/features/settings/SignaturesSection.test.tsx`
Expected: PASS (all existing + 2 new tests).

- [ ] **Step 7: Add preview styling**

Append to `src/features/settings/Settings.css`:

```css
.signatures-settings__html {
  min-height: 160px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre;
}

.signatures-settings__preview {
  margin-top: 8px;
}

.signature-preview-frame {
  width: 100%;
  min-height: 140px;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 6px;
  background: #ffffff;
}
```

- [ ] **Step 8: Commit**

```bash
git add src/features/reader/SafeHtmlFrame.tsx src/features/settings/SignaturesSection.tsx src/features/settings/Settings.css src/features/settings/SignaturesSection.test.tsx
git commit -m "feat(signatures): raw HTML edit mode with sandboxed preview in settings"
```

---

### Task 4: Composer — preview + append-at-send

**Files:**
- Modify: `src/features/composer/Composer.tsx`
- Modify: `src/features/composer/composer.css`
- Test: `src/features/composer/Composer.test.tsx`

**Interfaces:**
- Consumes: `Signature.is_html`, `SafeHtmlFrame`.
- Produces: no exported API change; internal behavior only.

- [ ] **Step 1: Write the failing Composer tests**

In `src/features/composer/Composer.test.tsx`, add inside the `describe`:

```ts
it("does NOT inject an HTML signature into the editor, but appends it to html_body only on Send", async () => {
  const { commands } = await import("../../ipc/bindings");
  (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: "ok",
    data: [{ id: 9, name: "Fancy", html: "<table>HTML-SIG</table>", is_default: true, is_html: true }],
  });

  render(<Composer />, { wrapper: Wrapper });
  await screen.findByRole("dialog");

  await waitFor(() => {
    expect(commands.listSignatures).toHaveBeenCalled();
  });
  const injected = mockSetContent.mock.calls.find((c) => String(c[0]).includes("HTML-SIG"));
  expect(injected).toBeUndefined();

  const sendButton = await screen.findByRole("button", { name: "Send" });
  fireEvent.click(sendButton);

  await waitFor(() => {
    expect(commands.saveDraft).toHaveBeenCalled();
  });
  const message = (commands.saveDraft as ReturnType<typeof vi.fn>).mock.calls[0][2];
  expect(message.html_body).toContain("<table>HTML-SIG</table>");
  expect(message.html_body.indexOf("Hello world")).toBeLessThan(message.html_body.indexOf("HTML-SIG"));
});

it("does NOT append the HTML signature on autosave/draft save", async () => {
  const { commands } = await import("../../ipc/bindings");
  (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: "ok",
    data: [{ id: 9, name: "Fancy", html: "<table>HTML-SIG</table>", is_default: true, is_html: true }],
  });

  render(<Composer />, { wrapper: Wrapper });
  await screen.findByRole("dialog");
  await waitFor(() => expect(commands.listSignatures).toHaveBeenCalled());

  const saveDraftButton = await screen.findByRole("button", { name: "Save draft" });
  fireEvent.click(saveDraftButton);

  await waitFor(() => {
    expect(commands.saveDraft).toHaveBeenCalled();
  });
  const message = (commands.saveDraft as ReturnType<typeof vi.fn>).mock.calls[0][2];
  expect(message.html_body).not.toContain("HTML-SIG");
});

it("renders a sandboxed preview iframe for an active HTML signature", async () => {
  const { commands } = await import("../../ipc/bindings");
  (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: "ok",
    data: [{ id: 9, name: "Fancy", html: "<table>HTML-SIG</table>", is_default: true, is_html: true }],
  });

  render(<Composer />, { wrapper: Wrapper });
  await screen.findByRole("dialog");

  const frame = await screen.findByTitle("signature-preview");
  expect(frame.getAttribute("sandbox")).toBe("");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/composer/Composer.test.tsx`
Expected: FAIL — HTML signature currently goes through `insertSignature`/`setContent`, is not appended at send, no preview iframe.

- [ ] **Step 3: Add the `SafeHtmlFrame` import and `htmlToText` helper + active-signature state**

In `src/features/composer/Composer.tsx`, add the import near the other feature imports (after line 9):

```tsx
import { SafeHtmlFrame } from "../reader/SafeHtmlFrame";
```

Add this module-level helper near `rewriteInlineSrcs` (after line 29):

```tsx
function htmlToText(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent ?? "";
}
```

Add active-signature state right after the `signatureInsertedRef` declaration (after line 71):

```tsx
const [activeHtmlSignature, setActiveHtmlSignature] = useState<Signature | null>(null);
```

- [ ] **Step 4: Update the signature auto-insert effect to branch on `is_html`**

Replace the effect at lines 84-98:

```tsx
useEffect(() => {
  if (signatureInsertedRef.current) return;
  if (!editor) return;
  if (signatures.length === 0) return;
  signatureInsertedRef.current = true;
  const sig = signatures.find((s) => s.is_default);
  if (!sig) return;
  if (sig.is_html) {
    setActiveHtmlSignature(sig);
    return;
  }
  if (composer.draftId != null) return;
  const quote = prefill?.html_body ?? "";
  editor.commands.setContent(`<p></p>${sig.html}${quote}`);
  editor.commands.focus("start");
}, [editor, signatures, composer.draftId, prefill?.html_body]);
```

- [ ] **Step 5: Update `buildMessage` to take `forSend` and append the HTML signature**

Replace `buildMessage` (lines 106-122):

```tsx
const buildMessage = useCallback(
  (forSend: boolean) => {
    const rawHtml = editor?.getHTML() ?? null;
    let html_body = rawHtml ? rewriteInlineSrcs(rawHtml, inlineSrcMapRef.current) : null;
    let text_body = editor?.getText() ?? "";
    if (forSend && activeHtmlSignature) {
      html_body = `${html_body ?? ""}${activeHtmlSignature.html}`;
      text_body = `${text_body}\n\n${htmlToText(activeHtmlSignature.html)}`;
    }
    return {
      from_address: accounts.find((a) => a.id === accountId)?.email ?? "",
      from_name: accounts.find((a) => a.id === accountId)?.display_name ?? null,
      to,
      cc,
      bcc,
      subject,
      text_body,
      html_body,
      in_reply_to: prefill?.in_reply_to ?? null,
      references: prefill?.references ?? [],
      attachments,
    };
  },
  [accounts, accountId, to, cc, bcc, subject, editor, attachments, prefill, activeHtmlSignature],
);
```

- [ ] **Step 6: Update the three `buildMessage()` call sites**

- In `scheduleAutosave` (line 130): `const message = buildMessage(false);`
- In `handleSend` (line 154): `const message = buildMessage(true);`
- In `handleSaveDraft` (line 172): `const message = buildMessage(false);`

- [ ] **Step 7: Branch the signature dropdown on `is_html`**

Replace the dropdown `onChange` (lines 409-413):

```tsx
onChange={(e) => {
  const sig = signatures.find((s) => String(s.id) === e.target.value);
  if (sig) {
    if (sig.is_html) {
      setActiveHtmlSignature(sig);
    } else {
      insertSignature(sig.html);
    }
  }
  e.currentTarget.value = "";
}}
```

- [ ] **Step 8: Render the preview block after the editor**

Replace the `.composer-editor` block (lines 358-360):

```tsx
<div className="composer-editor">
  <EditorContent editor={editor} />
</div>

{activeHtmlSignature && (
  <div className="composer-signature-preview">
    <div className="composer-signature-preview__label">Signature preview</div>
    <SafeHtmlFrame
      html={activeHtmlSignature.html}
      title="signature-preview"
      className="signature-preview-frame"
    />
  </div>
)}
```

- [ ] **Step 9: Run the Composer tests to verify they pass**

Run: `npx vitest run src/features/composer/Composer.test.tsx`
Expected: PASS — including the 3 new tests AND the unchanged `passes html_body from editor getHTML to saveDraft` (no signatures → no append), `auto-inserts the default signature above the quote on a fresh reply` (non-html sig still inline), and `does not auto-insert a signature when reopening an existing draft` (non-html sig).

- [ ] **Step 10: Add composer preview styling**

Append to `src/features/composer/composer.css`:

```css
.composer-signature-preview {
  margin: 8px 16px;
}

.composer-signature-preview__label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
  margin-bottom: 4px;
}

.composer-signature-preview .signature-preview-frame {
  width: 100%;
  min-height: 120px;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 6px;
  background: #ffffff;
}
```

- [ ] **Step 11: Full frontend test + typecheck**

Run: `npx tsc --noEmit && npm test`
Expected: typecheck clean; full Vitest suite PASS.

- [ ] **Step 12: Commit**

```bash
git add src/features/composer/Composer.tsx src/features/composer/composer.css src/features/composer/Composer.test.tsx
git commit -m "feat(signatures): HTML signature preview and append-at-send in composer"
```

---

## Manual verification (after all tasks)

1. Settings → Signatures: create a signature, click "Edit HTML source", paste a table-based HTML signature with inline CSS and a `data:`-URI logo. The preview iframe renders it correctly. Save.
2. Compose a NEW mail. The HTML signature does NOT appear inside the editor; a "Signature preview" block shows it below the editor.
3. Send to yourself. The received mail's `text/html` part contains the table/inline-CSS signature intact (sanitizer preserves email-safe HTML).
4. Reply to a thread with an HTML default signature: the signature lands at the end of `html_body` (below the quote) — known v1 limitation (FU1).
5. A plain (non-HTML) signature still behaves as before: injected inline above the quote.

## Known limitations (carried from spec)

- FU1: in replies the HTML signature is appended below the quote, not between body and quote.
- FU2: reopening a draft re-applies the account's default HTML signature, not the exact one chosen at compose time.
- FU3: the `text/plain` part contains a tags-stripped text rendering of the HTML signature (no layout).
