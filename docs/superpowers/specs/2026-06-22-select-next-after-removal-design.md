# Select next message after a removing action

## Goal

After an action that removes the current row(s) from the visible list — archive,
move to folder, delete, or snooze — the neighbouring message becomes selected and
opens in the reader (auto-advance), instead of clearing the selection and leaving
the reader empty.

## Decisions

- **Auto-advance into the reader.** The next row is selected *and* shown in the
  right pane (matches Gmail / Apple Mail). In this 3-pane layout selecting a single
  row already opens it in the reader.
- **Applies to bulk too.** After a multi-select bulk action the single nearest
  survivor is selected.
- **Covered actions:** archive, move-to-folder, delete, snooze.
- **Not covered:** mark as read / unread (does not remove rows from the list).

## Neighbour selection rule

Given the visible row ids and the removed row ids, pick the next selection:

1. The first surviving row positioned **after** the last removed row.
2. If the removed block sits at the bottom, the last surviving row **above** it.
3. If nothing survives, clear the selection (empty reader).

## Architecture

Single source of truth, five call sites.

1. **Pure helper** `selectNextAfterRemoval(visibleIds, removedIds): number | null`
   in `src/shared/selection/`. No React, no store — unit tested in isolation.

2. **Store action** `advanceSelectionAfter(removedRowIds: number[])` in
   `src/app/store.ts`. Reads `visibleMessageIds` + `selectMode`, runs the helper,
   then either selects the next row (setting `selectedThreadId` or
   `selectedMessageId` per mode, plus `selectedRowIds` and `selectionAnchorId`) or
   clears the selection when the helper returns `null`.

3. **Call sites** replace `clearSelection() + setSelectedThreadId(null)` with
   `advanceSelectionAfter(selectedRowIds)`:
   - `ShortcutsProvider.doMove` (keyboard `e` / `#`)
   - `BulkActionPanel.move`
   - `ConversationView.moveThread` (reader toolbar)
   - `FolderPicker.handlePick` (move to folder)
   - `SnoozePicker.apply` (snooze) — currently does not clear selection at all

## Why compute synchronously

The move/delete/snooze mutations are not optimistic; `onSuccess` invalidates the
queries and the list refetches. The next id is therefore computed synchronously at
action time, while the removed rows are still present in `visibleMessageIds`, and
points at a row that will survive the refetch. After the refetch the removed rows
disappear and the selection stays on the chosen neighbour.

## Id space

`selectedRowIds` lives in the same id space as `visibleMessageIds` (thread ids in
thread mode, message ids in flat/smart mode). Passing `selectedRowIds` as the
removed-row set is correct for every call site without conversion.

## Tests

- Helper: middle / top / bottom removal, contiguous block, all-removed, and a
  non-contiguous bulk selection.
- Store: thread mode and message mode auto-advance, and clearing when the helper
  returns `null`.
