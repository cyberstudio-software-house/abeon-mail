# Etap 6c — Full-text search (FTS5) (design)

> Sub-etap 6c of Etap 6 (UX power). Activates message search across all
> accounts, backed by SQLite FTS5. Wires the dormant `search_fts` table, the
> `MailboxRail` search placeholder, and the `search` (`/`) action reserved in
> Etap 6b.

Master spec: `docs/superpowers/specs/2026-06-17-abeonmail-design.md`.
Visual source: `docs/templates/AbeonMail.html` (search input lives in the rail;
results reuse the existing message-list pane).

## Goal

Typing a query searches mail across every account and folder and shows the
matches in the message-list pane. Headers (subject / from / to / attachment
names) are always searchable; message body text is searchable for messages
whose body is already stored locally (best-effort, grows as mail is read).
Search is global, supports a small set of Gmail-style operators, and is
reachable from a rail search bar and the `Mod+K` palette.

## Scope decisions (locked during brainstorming)

- **Coverage:** headers + snippet always; body `text_plain` for messages whose
  body is already in `message_bodies` (best-effort). No full body back-fill.
- **Surface:** primary is a search bar in `MailboxRail` → results render in the
  message-list pane. The `Mod+K` palette "Search mail" action and the `/`
  shortcut only focus that bar (single results surface, two entry points).
- **Scope:** global — all accounts, all folders. Excludes `draft=1`,
  `deleted=1`, and `trash`/`spam` folder types (consistent with smart folders).
- **Query syntax:** plain terms (full-text AND) plus operators `from:`, `to:`,
  `subject:`, `has:attachment`. No OR / NOT / NEAR.

Frontend + Rust. One migration (V7). One new Tauri command (`searchMessages`).
No new dependency.

## Architecture

```
sync envelope   ──► search_repo::index_message  (subject, from, to, attachment-names; body empty)
fetch body      ──► get_or_fetch_body ──► search_repo::index_body  (mix in text_plain)
delete message  ──► AFTER DELETE trigger on messages ──► clears the FTS row
                                                           │
query ◄── searchMessages (am-app) ◄── search_repo::search ◄── parse_query (am-core)
```

The FTS index lives in Rust. It is written explicitly from the repo layer for
inserts and body updates (testable, consistent with the rest of the codebase),
and cleaned up by a single `AFTER DELETE` trigger so cascade deletes
(`delete_by_folder`, `delete_by_uids`, folder/account cascade) never leave
orphaned index rows.

## Data model

### FTS table (migration V7)

The V1 `search_fts` table (declared `content=''`, never populated) is dropped
and recreated as a **standard stored FTS5 table**:

```sql
DROP TABLE IF EXISTS search_fts;

CREATE VIRTUAL TABLE search_fts USING fts5(
    subject,
    from_address,
    to_addresses,
    body_text,
    attachment_names,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);

CREATE TRIGGER messages_ad_fts AFTER DELETE ON messages BEGIN
    DELETE FROM search_fts WHERE rowid = old.id;
END;
```

Rationale for dropping `content=''`: best-effort body means a row is
re-indexed when its body arrives later. A contentless table requires the old
column values to issue the FTS5 `'delete'` command; a stored table re-indexes
with a plain `DELETE FROM search_fts WHERE rowid=?` + `INSERT`. The extra disk
(a copy of subject + body text) is acceptable for an offline-first client that
already stores bodies in `message_bodies`.

- `rowid = messages.id` (1:1), so joins back to `messages` are by rowid.
- `remove_diacritics 2` → case- and diacritic-insensitive matching (Polish:
  "raport" matches "rapórt").
- `prefix = '2 3'` → fast prefix matching while typing.

### Parsed query (am-core)

```rust
pub struct ParsedQuery {
    pub fts_match: Option<String>,   // FTS5 MATCH expression, or None if no text terms
    pub require_attachment: bool,    // has:attachment
}
```

`parse_query(raw: &str) -> ParsedQuery`:

- Splits on whitespace, honoring `key:value` operator tokens.
- Operators: `from:`, `to:`, `subject:` map to FTS column filters; everything
  else is a free term searched across all columns. `has:attachment` sets
  `require_attachment` (handled in SQL, not FTS).
- **Each term is double-quoted and suffixed with `*`** to neutralize raw FTS5
  syntax and enable prefix matching: a free term `report` becomes `"report"*`;
  `from:alice` becomes `from_address : "alice"*`. Terms are combined with `AND`.
- Empty / whitespace-only / operators-only-with-no-attachment input yields
  `fts_match = None` and `require_attachment = false` → caller returns no
  results (empty search is not "match everything").
- A lone `has:attachment` yields `fts_match = None, require_attachment = true`
  → caller may run an attachment-only listing (see below).

Quoting also makes embedded FTS metacharacters (`"`, `*`, `(`, `:`, `^`) inert:
a stray `"` in a term is escaped by doubling it inside the quoted string.

## Indexing (am-storage::search_repo + am-sync hooks)

`am-storage/src/search_repo.rs`:

- `index_message(db, id, subject, from_address, to_addresses, attachment_names)`
  — `DELETE FROM search_fts WHERE rowid=?` then `INSERT` with `rowid=id` and an
  empty `body_text`. Called from the envelope upsert path.
- `index_body(db, id, subject, from_address, to_addresses, body_text, attachment_names)`
  — same delete-then-insert, now carrying `body_text`. Called after a body is
  fetched and stored.
- `search(db, parsed, limit, offset) -> Vec<SmartMessageRow>` — see below.

`am-sync` wiring:

- In the envelope sync path that upserts message headers, call `index_message`
  for each upserted message.
- In `service::get_or_fetch_body`, after `store_body` + `backfill_body_meta`,
  call `index_body` with the freshly parsed `text_plain` (and the message's
  current header fields). This is the best-effort body hook.

No explicit removal calls are needed: the `AFTER DELETE` trigger covers every
deletion path including FK cascades.

## Search query (am-storage::search_repo::search)

```sql
SELECT m.id, m.account_id, a.color, a.email, f.name AS folder_name,
       m.from_address, m.from_name, m.subject, m.snippet, m.date,
       m.seen, m.flagged, m.has_attachments, m.thread_id
FROM search_fts s
JOIN messages m ON m.id = s.rowid
JOIN folders  f ON f.id = m.folder_id
JOIN accounts a ON a.id = m.account_id
WHERE search_fts MATCH ?            -- only when fts_match is Some
  AND m.draft = 0 AND m.deleted = 0
  AND f.folder_type NOT IN ('trash', 'spam')
  AND (? = 0 OR m.has_attachments = 1)   -- require_attachment
ORDER BY m.date DESC
LIMIT ? OFFSET ?;
```

- Returns `SmartMessageRow` (reused from Etap 5 — carries account color, folder
  name, thread id for the cross-account flat list).
- `ORDER BY date DESC` (recency over bm25 relevance — the expected default for
  mail).
- `has:attachment`-only query (no text terms): run the same query without the
  `search_fts MATCH` clause (a plain `messages` listing filtered by
  `has_attachments = 1`), so `has:attachment` works standalone.

`am-app` command:

```rust
#[tauri::command]
async fn search_messages(query: String, limit: u32, offset: u32)
    -> Result<Vec<SmartMessageRow>, String>
```

Bindings regenerated via `npm run gen:bindings`.

## Frontend

### Store (useUiStore)

- `searchQuery: string` and `searchActive: boolean` (active = a non-empty query
  is being shown). Pure setters `setSearchQuery`, `clearSearch`. Entering search
  is mutually exclusive with folder/smart-folder selection in the list pane
  (search results take over the pane; clearing returns to the prior folder).

### Search bar (MailboxRail)

- Replaces the inert `Search` placeholder with a real `<input>`. Typing updates
  `searchQuery`; a **200 ms debounce** drives the query hook. `Esc` or the ✕
  clears (`clearSearch`) and returns to the folder view.
- Placeholder/hint text communicates coverage: "Search all mail (body of opened
  messages)".

### Query hook

- `useSearch(query)` — react-query, `enabled: query.trim().length > 0`, calls
  `searchMessages(query, limit, 0)`. Keeps prior data while typing
  (`placeholderData`) to avoid flicker.

### Results in MessageListPane

- When `searchActive`, the pane renders a results header ("Results for
  '<query>'" + count, with a ✕ to clear) and the flat virtualized list (reuse
  the smart-folder row component with account color dots).
- Selecting a result opens its thread/message in the reader (same selection flow
  as smart folders).
- Empty result set → "No matches" state.
- **Match highlighting is client-side**: the query's free terms are bolded
  within the rendered subject / snippet (we already display both; no FTS
  `snippet()` needed). Diacritic-insensitive comparison mirrors the index.

### Shortcut + palette wiring (activate the 6b reservations)

- `registry.ts`: `search` action becomes `enabled: true`; its handler focuses
  the rail search input.
- Palette `CommandPalette.tsx`: a "Search mail" action focuses the same input
  and closes the palette.
- The `/` binding now triggers the focus handler.

## Error handling

- A malformed FTS expression can never reach SQLite because every term is
  quoted/escaped; an empty parse yields no query rather than an error.
- `searchMessages` surfaces storage errors as `Err(String)`; the hook shows a
  non-blocking inline error in the results header (does not crash the pane).
- Searching while an account is mid-sync is safe — the index is read with the
  same connection model as other reads; partial coverage simply means fewer
  rows, never an error.

## Testing

### Rust

- `am-core::search` parser: free terms → quoted/prefixed AND; `from:`/`to:`/
  `subject:` → column filters; `has:attachment` → `require_attachment`; embedded
  `"`/`*`/`:` escaped; empty / whitespace / operators-only-no-attachment →
  `fts_match None`; lone `has:attachment` → attachment-only.
- `search_repo`: index_message then search matches by subject/from/to;
  best-effort body becomes searchable only after `index_body`; trash/spam,
  `draft=1`, `deleted=1` excluded; cross-account results carry the right account
  color + folder; deleting a message (incl. via folder cascade) removes it from
  results (trigger); diacritic-insensitive hit ("rapórt" found by "raport").

### Frontend

- Search bar updates query and debounces; `Esc`/✕ clears and restores folder
  view.
- Results mode renders header + count; selecting a result opens the reader.
- Free-term highlighting bolds matches in subject/snippet (diacritic-insensitive).
- `/` focuses the search input; palette "Search mail" action focuses it.
- Empty-query hook is disabled (no IPC); empty result set shows "No matches".

## Implementation notes (as built)

- The FTS row is rebuilt by a single canonical `am-storage::search_repo::reindex_message`, which reconstructs all columns from the `messages` / `message_bodies` / `attachments` tables. It is called inside `insert_headers` (envelope sync, same transaction) and from `am-sync::get_or_fetch_body` after the body is stored. This supersedes the two-hook (`index_message` / `index_body`) sketch above with a DRY-er, always-current realization.
- `messages.to_addresses` is not populated at envelope-sync time (only `from`/subject are). It is persisted (with `cc_addresses`) in `get_or_fetch_body` when a body is fetched, then reindexed. Consequently the `to:` operator is **best-effort, exactly like body search**: it matches a received message only once that message's body has been opened/fetched. Indexing `to:` at envelope time would require fetching recipients during sync (deferred — see the existing "store To/Cc on the messages row during sync" tech-debt).

### Infra

- No new dependency. No new lucide icons beyond those already in
  `lucide-stub.js` (reuse the existing search/x glyphs already imported by the
  rail/list; if a genuinely new icon is introduced it MUST be added to the stub
  or vitest OOMs).

## Implementation plan staging

1. Migration V7 (recreate `search_fts` stored + delete trigger).
2. `am-core::search` query parser (pure, tests).
3. `am-storage::search_repo` index + search functions (tests).
4. `am-sync` indexing hooks (`index_message` on envelope upsert, `index_body`
   in `get_or_fetch_body`).
5. `am-app` `search_messages` command + regenerate bindings.
6. Store slice (`searchQuery`/`searchActive` + setters) and `useSearch` hook.
7. `MailboxRail` search bar (debounce, clear).
8. `MessageListPane` results mode + client-side highlight.
9. Activate `search` action + palette "Search mail" (focus the bar); fidelity /
   a11y pass.

## Deferred (out of 6c)

- Full body back-fill (index every message's body proactively).
- OR / NOT / NEAR, `in:folder`, date-range operators.
- "This folder only" scope toggle; saved searches; search history.
- bm25 relevance ranking option (results are recency-ordered).
