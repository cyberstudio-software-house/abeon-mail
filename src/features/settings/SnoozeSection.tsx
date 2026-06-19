import { useSnoozeSettings } from "../../shared/snooze/SnoozeProvider";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const OFFSETS = [1, 2, 3, 4, 6, 8, 12];
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

export function SnoozeSection() {
  const s = useSnoozeSettings();

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">Tune the snooze preset times.</p>

      <div className="appearance-field__label">Morning hour</div>
      <select
        aria-label="Morning hour"
        value={s.morningHour}
        onChange={(e) => s.setMorningHour(Number(e.target.value))}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, "0")}:00
          </option>
        ))}
      </select>

      <div className="appearance-field__label">"Later today" offset</div>
      <select
        aria-label="Later today offset"
        value={s.laterTodayHours}
        onChange={(e) => s.setLaterTodayHours(Number(e.target.value))}
      >
        {OFFSETS.map((h) => (
          <option key={h} value={h}>
            {h} hours
          </option>
        ))}
      </select>

      <div className="appearance-field__label">Weekend day</div>
      <select
        aria-label="Weekend day"
        value={s.weekendDay}
        onChange={(e) => s.setWeekendDay(Number(e.target.value))}
      >
        {WEEKDAYS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>

      <div className="appearance-field__label">Start of week</div>
      <select
        aria-label="Start of week"
        value={s.weekStartDay}
        onChange={(e) => s.setWeekStartDay(Number(e.target.value))}
      >
        {WEEKDAYS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}
