import { useEffect } from "react";
import { useUiStore } from "../../app/store";
import { useUndoMove } from "../../ipc/queries";
import "./UndoBar.css";

export const UNDO_TIMEOUT_MS = 8000;

export function UndoBar() {
  const toast = useUiStore((s) => s.undoToast);
  const clearUndoToast = useUiStore((s) => s.clearUndoToast);
  const undoMove = useUndoMove();

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => clearUndoToast(), UNDO_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [toast, clearUndoToast]);

  if (!toast) return null;

  const label = toast.kind === "archive" ? "Archived" : "Deleted";

  function onUndo() {
    if (!toast) return;
    undoMove.mutate({ messageIds: toast.messageIds });
    clearUndoToast();
  }

  return (
    <div className="undo-bar" role="status">
      <span className="undo-bar__label">{label}</span>
      <button type="button" className="undo-bar__action" aria-label="Undo" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
