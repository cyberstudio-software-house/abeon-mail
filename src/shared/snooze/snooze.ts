export type SnoozePresetKind = "later_today" | "tomorrow" | "this_weekend" | "next_week";

export const SNOOZE_PRESETS: { kind: SnoozePresetKind; label: string }[] = [
  { kind: "later_today", label: "Later today" },
  { kind: "tomorrow", label: "Tomorrow" },
  { kind: "this_weekend", label: "This weekend" },
  { kind: "next_week", label: "Next week" },
];

export type SnoozeConfig = {
  morningHour: number;
  laterTodayHours: number;
  weekendDay: number;
  weekStartDay: number;
};

export const SNOOZE_KEYS = {
  morningHour: "snooze.morningHour",
  laterTodayHours: "snooze.laterTodayHours",
  weekendDay: "snooze.weekendDay",
  weekStartDay: "snooze.weekStartDay",
} as const;

export const DEFAULT_SNOOZE_CONFIG: SnoozeConfig = {
  morningHour: 8,
  laterTodayHours: 3,
  weekendDay: 6,
  weekStartDay: 1,
};

function parseIntInRange(value: string, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function parseSnoozeSettings(pairs: [string, string][]): Partial<SnoozeConfig> {
  const out: Partial<SnoozeConfig> = {};
  for (const [key, value] of pairs) {
    switch (key) {
      case SNOOZE_KEYS.morningHour: {
        const n = parseIntInRange(value, 0, 23);
        if (n !== null) out.morningHour = n;
        break;
      }
      case SNOOZE_KEYS.laterTodayHours: {
        const n = parseIntInRange(value, 1, 12);
        if (n !== null) out.laterTodayHours = n;
        break;
      }
      case SNOOZE_KEYS.weekendDay: {
        const n = parseIntInRange(value, 0, 6);
        if (n !== null) out.weekendDay = n;
        break;
      }
      case SNOOZE_KEYS.weekStartDay: {
        const n = parseIntInRange(value, 0, 6);
        if (n !== null) out.weekStartDay = n;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function tomorrowAt(now: Date, hour: number): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, 0, 0, 0);
  return toEpochSeconds(d);
}

export function nextWeekdayAt(now: Date, weekday: number, hour: number): number {
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  while (candidate.getDay() !== weekday || candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return toEpochSeconds(candidate);
}

export function presetTimestamp(kind: SnoozePresetKind, now: Date, config: SnoozeConfig): number {
  switch (kind) {
    case "later_today":
      return toEpochSeconds(now) + config.laterTodayHours * 3600;
    case "tomorrow":
      return tomorrowAt(now, config.morningHour);
    case "this_weekend":
      return nextWeekdayAt(now, config.weekendDay, config.morningHour);
    case "next_week":
      return nextWeekdayAt(now, config.weekStartDay, config.morningHour);
  }
}

export function formatWakeTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
