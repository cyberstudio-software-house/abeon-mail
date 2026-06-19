import { describe, it, expect } from "vitest";
import { hour12Option, formatMessageTime, formatListDate, formatWakeTime } from "./datetime";

const TWO_PM = new Date(2026, 5, 19, 14, 30, 0);
const ts = Math.floor(TWO_PM.getTime() / 1000);

describe("hour12Option", () => {
  it("maps formats to the Intl hour12 flag", () => {
    expect(hour12Option("system")).toBeUndefined();
    expect(hour12Option("12h")).toBe(true);
    expect(hour12Option("24h")).toBe(false);
  });
});

describe("formatMessageTime", () => {
  it("renders 24-hour clock for 24h", () => {
    expect(formatMessageTime(ts, "24h")).toContain("14");
  });

  it("does not render a 24-hour hour for 12h", () => {
    expect(formatMessageTime(ts, "12h")).not.toContain("14");
  });

  it("returns a non-empty string for system", () => {
    expect(formatMessageTime(ts, "system").length).toBeGreaterThan(0);
  });
});

describe("formatListDate", () => {
  it("shows a time for today's date", () => {
    const todayTwoPm = new Date();
    todayTwoPm.setHours(14, 30, 0, 0);
    const out = formatListDate(Math.floor(todayTwoPm.getTime() / 1000), "24h");
    expect(out).toContain("14");
  });

  it("shows a month/day for older dates regardless of format", () => {
    const out = formatListDate(ts, "12h");
    expect(out).not.toContain("14");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("formatWakeTime", () => {
  it("returns a non-empty string and honours 24h", () => {
    expect(formatWakeTime(ts, "24h")).toContain("14");
  });
});
