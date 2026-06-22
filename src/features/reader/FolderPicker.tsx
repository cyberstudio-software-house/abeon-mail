import { useFolders, useMoveToFolder } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import "./FolderPicker.css";

const HIDDEN_TYPES = new Set(["drafts", "sent", "trash"]);

export function FolderPicker() {
  const open = useUiStore((s) => s.folderPickerOpen);
  const targetIds = useUiStore((s) => s.folderPickerTargetIds);
  const accountId = useUiStore((s) => s.folderPickerAccountId);
  const close = useUiStore((s) => s.closeFolderPicker);
  const showUndoToast = useUiStore((s) => s.showUndoToast);
  const move = useMoveToFolder();
  const { data: folders } = useFolders(accountId);

  if (!open) return null;

  const movable = (folders ?? []).filter((f) => !HIDDEN_TYPES.has(f.folder_type));

  function handlePick(folderId: number) {
    if (targetIds.length === 0) return;
    move.mutate({ messageIds: targetIds, targetFolderId: folderId });
    showUndoToast("move", targetIds);
    const s = useUiStore.getState();
    s.advanceSelectionAfter(s.selectMode === "message" ? targetIds : s.selectedRowIds);
    close();
  }

  return (
    <div className="folder-picker__overlay" role="dialog" aria-label="Move to folder" onClick={() => close()}>
      <div className="folder-picker" onClick={(e) => e.stopPropagation()}>
        <div className="folder-picker__title">Move to folder</div>
        <ul className="folder-picker__list">
          {movable.map((f) => (
            <li key={f.id}>
              <button type="button" className="folder-picker__item" onClick={() => handlePick(f.id)}>
                {f.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
