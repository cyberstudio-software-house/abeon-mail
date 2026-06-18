import { describe, it, expect } from "vitest";
import { initials, avatarColor, parseSettings, DEFAULT_APPEARANCE } from "./appearance";

describe("initials", () => {
  it("takes first letters of first two words", () => {
    expect(initials("Malak Frederick")).toBe("MF");
    expect(initials("Grover Cortez")).toBe("GC");
  });
  it("falls back to first two chars of a single token or email", () => {
    expect(initials("support@abeon.hosting")).toBe("SU");
    expect(initials("alice")).toBe("AL");
  });
  it("handles empty input", () => {
    expect(initials("")).toBe("?");
  });
});

describe("avatarColor", () => {
  it("is deterministic for the same seed", () => {
    expect(avatarColor("a@b.com")).toBe(avatarColor("a@b.com"));
  });
  it("returns a hex color from the palette", () => {
    expect(avatarColor("x@y.com")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("parseSettings", () => {
  it("maps known keys, ignores unknown, keeps defaults for missing", () => {
    const parsed = parseSettings([
      ["appearance.theme", "dark"],
      ["appearance.density", "compact"],
      ["appearance.showPreview", "false"],
      ["unknown.key", "whatever"],
    ]);
    expect(parsed.theme).toBe("dark");
    expect(parsed.density).toBe("compact");
    expect(parsed.showPreview).toBe(false);
    expect(parsed.accent).toBeUndefined();
  });
  it("rejects invalid enum values", () => {
    const parsed = parseSettings([["appearance.theme", "rainbow"]]);
    expect(parsed.theme).toBeUndefined();
  });
  it("maps a valid accent preset", () => {
    const parsed = parseSettings([["appearance.accent", "#10b981"]]);
    expect(parsed.accent).toBe("#10b981");
  });
  it("rejects an accent value not in ACCENT_PRESETS", () => {
    const parsed = parseSettings([["appearance.accent", "#123456"]]);
    expect(parsed.accent).toBeUndefined();
  });
  it("leaves showPreview undefined for a bogus boolean value", () => {
    const parsed = parseSettings([["appearance.showPreview", "garbage"]]);
    expect(parsed.showPreview).toBeUndefined();
  });
});

describe("DEFAULT_APPEARANCE", () => {
  it("defaults theme auto, accent indigo, density comfortable, toggles on", () => {
    expect(DEFAULT_APPEARANCE).toEqual({
      theme: "auto",
      accent: "#4f46e5",
      density: "comfortable",
      showPreview: true,
      showAvatars: true,
    });
  });
});
