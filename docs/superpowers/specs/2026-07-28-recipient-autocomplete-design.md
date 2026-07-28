# Recipient Autocomplete — Design

Date: 2026-07-28

## Goal

When the user types into a recipient field in the composer (To / Cc / Bcc),
suggest addresses drawn from the correspondence history. Selecting a suggestion
adds it as a chip; typing an address that is not in the history still works
exactly as it does today.

## Scope

In scope:

- A materialized contact index built from correspondence history.
- Suggestion dropdown in `RecipientField` with keyboard and mouse selection.
- One-time backfill of the index from data already in the database.
- One-time `ENVELOPE` re-scan of Sent folders to recover history whose bodies
  were never downloaded.
- Cross-account suggestions, ranked so that contacts of the sending account
  come first.

Out of scope:

- Editing, adding, or deleting contacts by hand. The index is derived data.
- Contact groups / distribution lists.
- Avatars (the `avatar_ref` column stays unused).
- Suggestions in the search bar or anywhere outside the composer.

## Contact eligibility rule

An address enters the index only when there was a two-way exchange:

1. It appears in `To`/`Cc` of a message stored in a folder of type
   `FolderType::Sent` — i.e. the user wrote to it, or replied to it.
2. It was a recipient of a message sent locally from AbeonMail.
3. Historically: it is the `from_address` of a message with `answered = 1` —
   i.e. the user replied to it before this feature existed.

Rule 3 exists only for the backfill. Going forward it is subsumed by rule 1,
because a reply lands in Sent and its recipient is harvested from there.

Senders of mail that was never answered are deliberately excluded. This keeps
newsletters, `noreply@`, and one-off notifications out of the suggestions.

## Existing infrastructure

- `contacts_cache` (V1 `initial_schema.sql:94`) already exists with
  `(id, account_id, email, name, avatar_ref)` and
  `UNIQUE(account_id, email)`, plus `ON DELETE CASCADE` on `account_id`.
  It has **zero** references in Rust and TypeScript — it was created for this
  feature and never wired up.
- IMAP `ENVELOPE` is already fetched during header sync
  (`crates/am-protocols/src/imap.rs:614`). Only `from`, `subject`,
  `message_id`, `date`, and `in_reply_to` are read from it; `to` and `cc` are
  available at no additional network cost and carry display names in
  `addr.name`.
- `FolderType::Sent` already exists and is assigned during folder discovery
  (`crates/am-storage/src/folders_repo.rs:16`).
- `messages.to_addresses` / `cc_addresses` hold JSON arrays of bare addresses,
  written only when a body is downloaded
  (`crates/am-sync/src/service.rs:522`). Display names are dropped by
  `am_mime::parse::addresses()`.
- Commands are registered in `collect_commands!`
  (`crates/am-app/src/lib.rs`) and exported to `src/ipc/bindings.ts` via
  tauri-specta.
- `RecipientField` (`src/features/composer/RecipientField.tsx`) is a 69-line
  chip input with no list of any kind.

## Chosen approach

A materialized contact index, updated at ingestion time and queried directly by
the composer.

Rejected alternatives:

- **Live query over `messages`.** No migration and always fresh, but
  `to_addresses` is a JSON blob: matching needs an unindexed `LIKE '%x%'` full
  scan plus JSON parsing per hit to extract individual addresses and compute a
  ranking. On a mailbox of tens of thousands of messages that is hundreds of
  milliseconds per keystroke.
- **In-memory cache built once per session.** No migration and fast after the
  first scan, but the first composer open stalls, the cache needs invalidation
  on every send, and it does not survive a restart.

## Data model — migration V18

Extend `contacts_cache`:

```sql
ALTER TABLE contacts_cache ADD COLUMN exchange_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts_cache ADD COLUMN last_contact_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts_cache ADD COLUMN search_key TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_contacts_search ON contacts_cache(search_key);
```

- `email` is stored lowercased and is the canonical identity.
- `exchange_count` counts harvest events, not distinct messages. Duplicate
  harvests of the same message are possible (re-sync) and acceptable: the value
  is a ranking signal, not a statistic.
- `last_contact_at` is the message date (Unix seconds).
- `search_key` is `"<name> <email>"` lowercased with diacritics stripped
  (`Łukasz Nowak <L.Nowak@firma.pl>` → `lukasz nowak l.nowak@firma.pl`).
  It exists because SQLite `LIKE` is case-insensitive for ASCII only, so
  `Łukasz` would not match `łukasz`.

One row per `(account_id, email)` pair. A shared pool with per-account ranking
falls out of a single `GROUP BY email` with `MAX(account_id = ?) AS same_account`,
and deleting an account removes its rows through the existing cascade.

## Harvest points

**1. Header sync (`crates/am-sync`).** When the folder being synced is of type
`Sent`, upsert every address from the envelope `To` and `Cc` lists, using
`addr.name` as the display name. `FetchedHeader` gains `to: Vec<(String, Option<String>)>`
and `cc: Vec<(String, Option<String>)>` populated in
`crates/am-protocols/src/imap.rs` from the envelope already in hand.

**2. Successful local send.** In the `Ok` arm of `drain_outbox`, upsert all
recipients of the message that was just sent (To, Cc and Bcc). This makes a
person the user just wrote to available immediately, without waiting for the
Sent folder to sync.

**3. Body download.** No new hook. `persist_body` already calls
`store_recipients`; the Sent-folder case is covered by point 1 with better data
(names included).

## Backfill

Two parts, both one-time.

**Part A — from the local database (migration V18).** For messages in folders of
type `Sent`, expand `to_addresses` and `cc_addresses` with `json_each` and
upsert the results. For messages with `answered = 1`, upsert `from_address` /
`from_name`. `json_each` is available: the bundled SQLite is 3.45.0 and
`libsqlite3-sys` compiles it with `-DSQLITE_ENABLE_JSON1`.

`search_key` cannot be computed in SQL, because diacritic stripping has no
SQLite equivalent. The migration writes rows with an empty `search_key`, and a
Rust pass in `crates/am-storage/src/maintenance.rs`, run once after migrations,
fills in every row where `search_key = ''`. The same pass therefore also repairs
any row whose name arrives later.

**Part B — Sent folder envelope re-scan (`crates/am-sync`).** Part A only sees
Sent messages whose bodies were downloaded, which in practice means folders
covered by prefetch. To recover the rest, a one-time task fetches
`ENVELOPE`-only (no body) for all UIDs in each Sent folder, in batches of 500,
and upserts contacts. Progress is tracked with a resumable cursor in the
`settings` table, following the V13 prefetch backfill pattern
(`contacts_backfill_uid:<folder_id>` plus a `contacts_backfill_complete` flag),
so an interrupted pass resumes instead of restarting. The task does not insert
or modify messages — it only feeds the contact index.

## Query and ranking

New command:

```rust
suggest_contacts(query: String, account_id: Option<i64>, limit: u32)
    -> Vec<ContactSuggestion { email, name, exchange_count, last_contact_at }>
```

The query string is normalized with the same function that produces
`search_key`. Candidates are matched with `search_key LIKE '%' || ?1 || '%'`,
grouped by `email`, and ordered by:

1. `same_account` descending — contacts of the account selected in the From
   field come first.
2. `prefix_match` descending — a match at the start of the name or of the
   address beats a match in the middle.
3. Recency bucket descending — within the last 30 days, within the last year,
   older.
4. `SUM(exchange_count)` descending.
5. `MAX(last_contact_at)` descending, as a deterministic tiebreak.

The display name is `MAX(name)` over the group, so a name learned on any
account is reused. An empty query returns no suggestions — the dropdown only
appears once the user starts typing.

## UI

`RecipientField` gains a suggestion list rendered below the input:

- At most 8 entries, each showing `Name <email>` (or just the address when no
  name is known), with the matched fragment emphasized.
- `↓` / `↑` move the active entry, `Enter` and `Tab` accept it, `Esc` closes the
  list, `Escape` a second time is left to the composer as today.
- Mouse click accepts an entry.
- Addresses already present as chips in the same field are filtered out.
- `Enter` with no active entry commits the typed text verbatim, preserving
  today's behaviour for addresses that are not in the history. `,` keeps
  committing the typed text as it does now.
- The list closes on blur, after the existing blur-commit logic runs.
- Combobox ARIA roles (`role="combobox"` on the input, `role="listbox"` /
  `role="option"` on the list) so the active entry is announced.

Suggestions are fetched through a React Query hook keyed by
`(query, fromAccountId)`. Queries are cheap; results are cached per key and the
input is debounced by 120 ms to avoid a request per keystroke.

## Error handling

- A failed `suggest_contacts` call leaves the field working as a plain chip
  input: the dropdown stays closed and nothing is surfaced to the user. Losing
  autocomplete must never block composing a message.
- Contact upserts during sync are best-effort. A failure is logged and skipped;
  it never fails message ingestion, since the contact index is derived data that
  the next sync can rebuild.
- Addresses that fail a basic sanity check (no `@`, or empty local part) are
  skipped at harvest time rather than stored and filtered later.

## Testing

Rust:

- `search_key` normalization: diacritics, case, name plus address.
- Upsert: inserts a new contact, increments `exchange_count` and advances
  `last_contact_at` on repeat, fills in a name that was previously missing and
  does not overwrite an existing name with `NULL`.
- Ranking order: same-account first, prefix before infix, recency bucket before
  count.
- Harvest from a Sent-folder header populates contacts; the same header in an
  Inbox folder does not.
- Backfill from `to_addresses` JSON and from `answered = 1` messages.
- Malformed addresses are rejected.

TypeScript:

- Typing filters the list and rendering shows names plus addresses.
- `↓`/`↑`/`Enter` selects; `Esc` closes without adding.
- `Enter` on an unknown address still adds it as a chip.
- An address already added as a chip disappears from the suggestions.
- A failing IPC call keeps the field usable.

## Known limitations

- `exchange_count` can be inflated by re-syncs. It is a ranking signal only.
- Contacts cannot be removed by hand. An address written to once stays in the
  index; ranking pushes it down over time but nothing prunes it.
- The one-time envelope re-scan costs one network pass over each Sent folder on
  first run after the update.
