import { describe, it, expect } from "vitest";
import { nextWeekdayAt, tomorrowAt, presetTimestamp, formatWakeTime } from "./snooze";

const FRIDAY = new Date(2026, 5, 19, 10, 0, 0);

describe("snooze presets", () => {
  it("later_today is now + 3h", () => {
    const ts = presetTimestamp("later_today", FRIDAY);
    expect(ts).toBe(Math.floor(FRIDAY.getTime() / 1000) + 3 * 3600);
  });

  it("tomorrow is next day at 08:00 local", () => {
    const ts = tomorrowAt(FRIDAY, 8);
    const d = new Date(ts * 1000);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });

  it("this_weekend is the upcoming Saturday 08:00", () => {
    const ts = nextWeekdayAt(FRIDAY, 6, 8);
    const d = new Date(ts * 1000);
    expect(d.getDay()).toBe(6);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(8);
  });

  it("next_week is the upcoming Monday 08:00", () => {
    const ts = nextWeekdayAt(FRIDAY, 1, 8);
    const d = new Date(ts * 1000);
    expect(d.getDay()).toBe(1);
    expect(d.getDate()).toBe(22);
    expect(d.getHours()).toBe(8);
  });

  it("nextWeekdayAt advances a full week when target is today but hour passed", () => {
    const satMorning = new Date(2026, 5, 20, 9, 0, 0);
    const ts = nextWeekdayAt(satMorning, 6, 8);
    const d = new Date(ts * 1000);
    expect(d.getDate()).toBe(27);
  });

  it("formatWakeTime returns a non-empty string", () => {
    expect(formatWakeTime(Math.floor(FRIDAY.getTime() / 1000)).length).toBeGreaterThan(0);
  });
});
