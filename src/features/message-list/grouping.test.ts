import { describe, it, expect } from "vitest";
import { groupLabel, groupIntoEntries } from "./grouping";

const NOON_TODAY = Math.floor(new Date(2026, 5, 18, 12, 0, 0).getTime() / 1000);

describe("groupLabel", () => {
  it("labels same calendar day as Today", () => {
    const morning = Math.floor(new Date(2026, 5, 18, 8, 0, 0).getTime() / 1000);
    expect(groupLabel(morning, NOON_TODAY)).toBe("Today");
  });
  it("labels previous calendar day as Yesterday", () => {
    const y = Math.floor(new Date(2026, 5, 17, 23, 0, 0).getTime() / 1000);
    expect(groupLabel(y, NOON_TODAY)).toBe("Yesterday");
  });
  it("labels older as Earlier", () => {
    const old = Math.floor(new Date(2026, 5, 10, 12, 0, 0).getTime() / 1000);
    expect(groupLabel(old, NOON_TODAY)).toBe("Earlier");
  });
});

describe("groupIntoEntries", () => {
  it("inserts a header before each new group, items keep order", () => {
    const items = [
      { id: 1, d: Math.floor(new Date(2026, 5, 18, 9).getTime() / 1000) },
      { id: 2, d: Math.floor(new Date(2026, 5, 17, 9).getTime() / 1000) },
      { id: 3, d: Math.floor(new Date(2026, 5, 1, 9).getTime() / 1000) },
    ];
    const entries = groupIntoEntries(items, (i) => i.d, NOON_TODAY);
    expect(entries).toEqual([
      { kind: "header", label: "Today" },
      { kind: "item", data: items[0] },
      { kind: "header", label: "Yesterday" },
      { kind: "item", data: items[1] },
      { kind: "header", label: "Earlier" },
      { kind: "item", data: items[2] },
    ]);
  });
  it("emits no header for an empty list", () => {
    expect(groupIntoEntries([], () => 0, NOON_TODAY)).toEqual([]);
  });
});
