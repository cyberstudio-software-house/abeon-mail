import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  useLabels,
  useCreateLabel,
  useRenameLabel,
  useSetLabelColor,
  useDeleteLabel,
} from "../../ipc/queries";
import { LABEL_COLORS, nextLabelColor } from "../../shared/labels/labels";

export function LabelsSection() {
  const { data: labels = [] } = useLabels();
  const createLabel = useCreateLabel();
  const renameLabel = useRenameLabel();
  const setLabelColor = useSetLabelColor();
  const deleteLabel = useDeleteLabel();
  const [newName, setNewName] = useState("");

  function add() {
    const name = newName.trim();
    if (!name) return;
    const color = nextLabelColor(labels.map((l) => l.color));
    createLabel.mutate({ name, color });
    setNewName("");
  }

  return (
    <div className="settings-section">
      <ul className="labels-settings__list">
        {labels.map((label) => (
          <li key={label.id} className="labels-settings__row">
            <select
              className="settings-select"
              aria-label={`Color for ${label.name}`}
              value={label.color}
              onChange={(e) => setLabelColor.mutate({ id: label.id, color: e.target.value })}
            >
              {LABEL_COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="settings-input"
              aria-label={`Rename ${label.name}`}
              defaultValue={label.name}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== label.name) renameLabel.mutate({ id: label.id, name: v });
              }}
            />
            <button
              type="button"
              className="settings-btn settings-btn--icon"
              aria-label={`Delete label ${label.name}`}
              onClick={() => deleteLabel.mutate(label.id)}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
      <div className="labels-settings__add">
        <input
          type="text"
          className="settings-input"
          aria-label="New label name"
          placeholder="New label name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" className="settings-btn settings-btn--primary" onClick={add}>
          Add label
        </button>
      </div>
    </div>
  );
}
