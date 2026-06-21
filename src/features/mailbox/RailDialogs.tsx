import { useState } from "react";

export function TextInputDialog({
  title,
  initialValue = "",
  placeholder,
  confirmLabel = "OK",
  onConfirm,
  onCancel,
}: {
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();

  function confirm() {
    if (trimmed.length === 0) return;
    onConfirm(trimmed);
  }

  return (
    <div className="rail-dialog-overlay" role="presentation" onClick={onCancel}>
      <div className="rail-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rail-dialog__title">{title}</div>
        <input
          className="rail-dialog__input"
          autoFocus
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="rail-dialog__actions">
          <button type="button" className="rail-dialog__btn" onClick={onCancel}>
            Anuluj
          </button>
          <button
            type="button"
            className="rail-dialog__btn rail-dialog__btn--primary"
            disabled={trimmed.length === 0}
            onClick={confirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "OK",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rail-dialog-overlay" role="presentation" onClick={onCancel}>
      <div className="rail-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="rail-dialog__title">{title}</div>
        <div className="rail-dialog__message">{message}</div>
        <div className="rail-dialog__actions">
          <button type="button" className="rail-dialog__btn" onClick={onCancel}>
            Anuluj
          </button>
          <button type="button" className="rail-dialog__btn rail-dialog__btn--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
