import { describe, it, expect } from "vitest";
import { LABEL_COLORS, nextLabelColor } from "./labels";

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
