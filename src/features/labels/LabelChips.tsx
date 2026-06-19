import type { Label } from "../../ipc/bindings";
import "./LabelChips.css";

export function LabelChips({ labels }: { labels: Label[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="label-chips">
      {labels.map((l) => (
        <span key={l.id} className="label-chip" style={{ backgroundColor: l.color }}>
          {l.name}
        </span>
      ))}
    </span>
  );
}
