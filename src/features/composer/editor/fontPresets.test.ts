import { describe, it, expect } from "vitest";
import { FONT_FAMILIES, FONT_SIZE_PRESETS, COLOR_SWATCHES } from "./fontPresets";

describe("font presets", () => {
  it("offers a default (reset) font family with null value", () => {
    expect(FONT_FAMILIES[0]).toEqual({ label: "Domyślna", value: null });
    expect(FONT_FAMILIES.length).toBeGreaterThanOrEqual(10);
  });

  it("maps named sizes with Normalny as reset", () => {
    const small = FONT_SIZE_PRESETS.find((size) => size.label === "Mały");
    const normal = FONT_SIZE_PRESETS.find((size) => size.label === "Normalny");
    const large = FONT_SIZE_PRESETS.find((size) => size.label === "Duży");
    expect(small?.value).toBe("13px");
    expect(normal?.value).toBeNull();
    expect(large?.value).toBe("18px");
  });

  it("provides a grid of hex swatches", () => {
    expect(COLOR_SWATCHES.length).toBeGreaterThanOrEqual(30);
    for (const color of COLOR_SWATCHES) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
