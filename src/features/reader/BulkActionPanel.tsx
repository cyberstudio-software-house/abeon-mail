import { useSetSeen, useArchive, useDelete } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { resolveSelectedMessageIds } from "../../shared/selection/resolveMessageIds";
import "./BulkActionPanel.css";

export function BulkActionPanel() {
  const selectedRowIds = useUiStore((s) => s.selectedRowIds);
  const rowAccounts = useUiStore((s) => s.rowAccounts);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const advanceSelectionAfter = useUiStore((s) => s.advanceSelectionAfter);
  const showUndoToast = useUiStore((s) => s.showUndoToast);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
  const openSnoozePicker = useUiStore((s) => s.openSnoozePicker);
  const openFolderPicker = useUiStore((s) => s.openFolderPicker);
  const setSeen = useSetSeen();
  const archive = useArchive();
  const del = useDelete();

  const count = selectedRowIds.length;
  const accounts = Array.from(
    new Set(selectedRowIds.map((id) => rowAccounts[id]).filter((a) => a != null))
  ) as number[];
  const singleAccount = accounts.length === 1 ? accounts[0] : null;

  async function withIds(fn: (ids: number[]) => void) {
    const ids = await resolveSelectedMessageIds();
    if (ids.length === 0) return;
    fn(ids);
  }

  function markSeen(value: boolean) {
    void withIds((ids) => {
      setSeen.mutate({ ids, value });
      clearSelection();
    });
  }

  function move(kind: "archive" | "delete") {
    const removedRowIds = selectedRowIds;
    void withIds((ids) => {
      if (kind === "archive") archive.mutate({ messageIds: ids });
      else del.mutate({ messageIds: ids });
      showUndoToast(kind, ids);
      advanceSelectionAfter(removedRowIds);
    });
  }

  function openMove() {
    if (singleAccount == null) return;
    void withIds((ids) => openFolderPicker(ids, singleAccount));
  }

  return (
    <div className="bulk-panel" aria-label="bulk-actions">
      <div className="bulk-panel__count">Selected {count} messages</div>
      <div className="bulk-panel__actions">
        <button type="button" onClick={() => markSeen(true)}>Mark as read</button>
        <button type="button" onClick={() => markSeen(false)}>Mark as unread</button>
        <button type="button" onClick={() => move("archive")}>Move to archive</button>
        <button type="button" onClick={() => move("delete")}>Delete</button>
        <button type="button" disabled={singleAccount == null} onClick={() => openMove()}>
          Move to folder…
        </button>
        <button type="button" onClick={() => void withIds((ids) => openLabelPicker(ids))}>Label…</button>
        <button type="button" onClick={() => void withIds((ids) => openSnoozePicker(ids))}>Snooze…</button>
      </div>
    </div>
  );
}
