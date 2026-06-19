import { useState } from "react";
import { Check } from "lucide-react";
import { useUiStore } from "../../app/store";
import {
  useLabels,
  useLabelsForMessages,
  useCreateLabel,
  useSetMessageLabels,
} from "../../ipc/queries";
import { nextLabelColor } from "../../shared/labels/labels";
import "./LabelPicker.css";

export function LabelPicker() {
  const open = useUiStore((s) => s.labelPickerOpen);
  const targetIds = useUiStore((s) => s.labelPickerTargetIds);
  const closeLabelPicker = useUiStore((s) => s.closeLabelPicker);
  const [filter, setFilter] = useState("");

  const { data: labels = [] } = useLabels();
  const { data: pairs = [] } = useLabelsForMessages(open ? targetIds : []);
  const createLabel = useCreateLabel();
  const setMessageLabels = useSetMessageLabels();

  if (!open) return null;

  const appliedCount = new Map<number, number>();
  for (const [, label] of pairs) {
    appliedCount.set(label.id, (appliedCount.get(label.id) ?? 0) + 1);
  }
  const isFullyApplied = (labelId: number) =>
    targetIds.length > 0 && appliedCount.get(labelId) === targetIds.length;

  const trimmed = filter.trim();
  const visible = labels.filter((l) => l.name.toLowerCase().includes(trimmed.toLowerCase()));
  const exactMatch = labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase());

  function toggle(labelId: number) {
    setMessageLabels.mutate({ labelId, messageIds: targetIds, applied: !isFullyApplied(labelId) });
  }

  async function createAndApply() {
    if (!trimmed || exactMatch) return;
    const color = nextLabelColor(labels.map((l) => l.color));
    const created = await createLabel.mutateAsync({ name: trimmed, color });
    setMessageLabels.mutate({ labelId: created.id, messageIds: targetIds, applied: true });
    setFilter("");
  }

  return (
    <div className="label-picker-overlay" role="presentation" onClick={closeLabelPicker}>
      <div className="label-picker" role="dialog" aria-label="Apply labels" onClick={(e) => e.stopPropagation()}>
        <input
          className="label-picker__input"
          autoFocus
          type="text"
          value={filter}
          aria-label="Filter or create label"
          placeholder="Filter or create label"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void createAndApply();
            if (e.key === "Escape") closeLabelPicker();
          }}
        />
        <ul className="label-picker__list">
          {visible.map((l) => (
            <li key={l.id}>
              <button type="button" className="label-picker__item" onClick={() => toggle(l.id)}>
                <span className="label-picker__dot" style={{ backgroundColor: l.color }} />
                <span className="label-picker__name">{l.name}</span>
                {isFullyApplied(l.id) && <Check size={14} className="label-picker__check" />}
              </button>
            </li>
          ))}
          {trimmed && !exactMatch && (
            <li>
              <button type="button" className="label-picker__item label-picker__create" onClick={() => void createAndApply()}>
                Create &ldquo;{trimmed}&rdquo;
              </button>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
