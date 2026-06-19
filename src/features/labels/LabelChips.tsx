import type { Label } from "../../ipc/bindings";
import { labelTextColor } from "../../shared/labels/labels";
import "./LabelChips.css";

export function LabelChips({ labels }: { labels: Label[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="label-chips">
      {labels.map((l) => (
        <span key={l.id} className="label-chip" style={{ backgroundColor: l.color, color: labelTextColor(l.color) }}>
          {l.name}
        </span>
      ))}
    </span>
  );
}
