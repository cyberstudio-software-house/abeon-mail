export type SnoozePresetKind = "later_today" | "tomorrow" | "this_weekend" | "next_week";

export const SNOOZE_PRESETS: { kind: SnoozePresetKind; label: string }[] = [
  { kind: "later_today", label: "Later today" },
  { kind: "tomorrow", label: "Tomorrow" },
  { kind: "this_weekend", label: "This weekend" },
  { kind: "next_week", label: "Next week" },
];

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

export function presetTimestamp(kind: SnoozePresetKind, now: Date): number {
  switch (kind) {
    case "later_today":
      return toEpochSeconds(now) + 3 * 3600;
    case "tomorrow":
      return tomorrowAt(now, 8);
    case "this_weekend":
      return nextWeekdayAt(now, 6, 8);
    case "next_week":
      return nextWeekdayAt(now, 1, 8);
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
