import { describe, it, expect } from "vitest";
import {
  nextWeekdayAt,
  tomorrowAt,
  presetTimestamp,
  parseSnoozeSettings,
  DEFAULT_SNOOZE_CONFIG,
  SNOOZE_KEYS,
} from "./snooze";

const FRIDAY = new Date(2026, 5, 19, 10, 0, 0);

describe("snooze presets", () => {
  it("later_today is now + laterTodayHours", () => {
    const ts = presetTimestamp("later_today", FRIDAY, DEFAULT_SNOOZE_CONFIG);
    expect(ts).toBe(Math.floor(FRIDAY.getTime() / 1000) + 3 * 3600);
  });

  it("respects a custom laterTodayHours offset", () => {
    const ts = presetTimestamp("later_today", FRIDAY, { ...DEFAULT_SNOOZE_CONFIG, laterTodayHours: 5 });
    expect(ts).toBe(Math.floor(FRIDAY.getTime() / 1000) + 5 * 3600);
  });

  it("tomorrow uses the configured morningHour", () => {
    const ts = presetTimestamp("tomorrow", FRIDAY, { ...DEFAULT_SNOOZE_CONFIG, morningHour: 6 });
    const d = new Date(ts * 1000);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(6);
  });

  it("this_weekend uses the configured weekendDay + morningHour", () => {
    const ts = presetTimestamp("this_weekend", FRIDAY, { ...DEFAULT_SNOOZE_CONFIG, weekendDay: 0, morningHour: 9 });
    const d = new Date(ts * 1000);
    expect(d.getDay()).toBe(0);
    expect(d.getHours()).toBe(9);
  });

  it("next_week uses the configured weekStartDay", () => {
    const ts = presetTimestamp("next_week", FRIDAY, { ...DEFAULT_SNOOZE_CONFIG, weekStartDay: 2 });
    const d = new Date(ts * 1000);
    expect(d.getDay()).toBe(2);
  });

  it("default config matches the legacy hardcoded behaviour", () => {
    expect(presetTimestamp("tomorrow", FRIDAY, DEFAULT_SNOOZE_CONFIG)).toBe(tomorrowAt(FRIDAY, 8));
    expect(presetTimestamp("this_weekend", FRIDAY, DEFAULT_SNOOZE_CONFIG)).toBe(nextWeekdayAt(FRIDAY, 6, 8));
    expect(presetTimestamp("next_week", FRIDAY, DEFAULT_SNOOZE_CONFIG)).toBe(nextWeekdayAt(FRIDAY, 1, 8));
  });

});

describe("parseSnoozeSettings", () => {
  it("parses valid integers in range", () => {
    const out = parseSnoozeSettings([
      [SNOOZE_KEYS.morningHour, "7"],
      [SNOOZE_KEYS.laterTodayHours, "4"],
      [SNOOZE_KEYS.weekendDay, "0"],
      [SNOOZE_KEYS.weekStartDay, "3"],
    ]);
    expect(out).toEqual({ morningHour: 7, laterTodayHours: 4, weekendDay: 0, weekStartDay: 3 });
  });

  it("rejects out-of-range and non-integer values", () => {
    expect(parseSnoozeSettings([[SNOOZE_KEYS.morningHour, "24"]]).morningHour).toBeUndefined();
    expect(parseSnoozeSettings([[SNOOZE_KEYS.laterTodayHours, "0"]]).laterTodayHours).toBeUndefined();
    expect(parseSnoozeSettings([[SNOOZE_KEYS.weekendDay, "9"]]).weekendDay).toBeUndefined();
    expect(parseSnoozeSettings([[SNOOZE_KEYS.morningHour, "abc"]]).morningHour).toBeUndefined();
    expect(parseSnoozeSettings([[SNOOZE_KEYS.morningHour, "1.5"]]).morningHour).toBeUndefined();
  });

  it("exposes defaults equal to the legacy values", () => {
    expect(DEFAULT_SNOOZE_CONFIG).toEqual({ morningHour: 8, laterTodayHours: 3, weekendDay: 6, weekStartDay: 1 });
  });
});
