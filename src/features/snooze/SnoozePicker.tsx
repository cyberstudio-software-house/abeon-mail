import { useState } from "react";
import { Clock, Calendar } from "lucide-react";
import { useUiStore } from "../../app/store";
import { useSnooze } from "../../ipc/queries";
import { SNOOZE_PRESETS, presetTimestamp, type SnoozePresetKind } from "../../shared/snooze/snooze";
import "./SnoozePicker.css";

export function SnoozePicker() {
  const open = useUiStore((s) => s.snoozePickerOpen);
  const targetIds = useUiStore((s) => s.snoozePickerTargetIds);
  const closeSnoozePicker = useUiStore((s) => s.closeSnoozePicker);
  const morningHour = useUiStore((s) => s.snoozeMorningHour);
  const laterTodayHours = useUiStore((s) => s.snoozeLaterTodayHours);
  const weekendDay = useUiStore((s) => s.snoozeWeekendDay);
  const weekStartDay = useUiStore((s) => s.snoozeWeekStartDay);
  const snooze = useSnooze();
  const [custom, setCustom] = useState("");

  if (!open) return null;

  function apply(wakeAt: number) {
    if (targetIds.length === 0) {
      closeSnoozePicker();
      return;
    }
    snooze.mutate({ messageIds: targetIds, wakeAt });
    closeSnoozePicker();
  }

  function applyPreset(kind: SnoozePresetKind) {
    apply(presetTimestamp(kind, new Date(), { morningHour, laterTodayHours, weekendDay, weekStartDay }));
  }

  function applyCustom() {
    if (!custom) return;
    const ms = new Date(custom).getTime();
    if (Number.isNaN(ms)) return;
    apply(Math.floor(ms / 1000));
  }

  return (
    <div className="snooze-picker-overlay" role="presentation" onClick={closeSnoozePicker}>
      <div className="snooze-picker" role="dialog" aria-label="Snooze until" onClick={(e) => e.stopPropagation()}>
        {SNOOZE_PRESETS.map((p) => (
          <button key={p.kind} type="button" className="snooze-picker__item" onClick={() => applyPreset(p.kind)}>
            <Clock size={15} />
            {p.label}
          </button>
        ))}
        <div className="snooze-picker__custom">
          <Calendar size={15} />
          <input
            type="datetime-local"
            aria-label="Pick date and time"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button type="button" onClick={applyCustom}>Set</button>
        </div>
      </div>
    </div>
  );
}
