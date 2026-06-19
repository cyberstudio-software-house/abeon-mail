import { describe, it, expect } from "vitest";
import { LABEL_COLORS, nextLabelColor, labelTextColor } from "./labels";

describe("nextLabelColor", () => {
  it("returns the first color when none are used", () => {
    expect(nextLabelColor([])).toBe(LABEL_COLORS[0]);
  });

  it("skips used colors", () => {
    expect(nextLabelColor([LABEL_COLORS[0], LABEL_COLORS[1]])).toBe(LABEL_COLORS[2]);
  });

  it("wraps when all colors are used", () => {
    const all = [...LABEL_COLORS];
    expect(LABEL_COLORS.includes(nextLabelColor(all))).toBe(true);
  });
});

describe("labelTextColor", () => {
  it("returns black for light amber #f59e0b", () => {
    expect(labelTextColor("#f59e0b")).toBe("#000000");
  });

  it("returns white for dark indigo #4f46e5", () => {
    expect(labelTextColor("#4f46e5")).toBe("#ffffff");
  });

  it("returns black for sky blue #0ea5e9", () => {
    expect(labelTextColor("#0ea5e9")).toBe("#000000");
  });
});
