import { describe, it, expect } from "vitest";
import {
  initials,
  senderAvatarColor,
  deriveAccentVars,
  parseSettings,
  DEFAULT_APPEARANCE,
} from "./appearance";

function lightness(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
}

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

describe("senderAvatarColor", () => {
  it("is deterministic for the same seed and accent", () => {
    expect(senderAvatarColor("a@b.com", "#4f46e5")).toBe(
      senderAvatarColor("a@b.com", "#4f46e5")
    );
  });
  it("returns a hex color", () => {
    expect(senderAvatarColor("x@y.com", "#4f46e5")).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it("keeps lightness in a band that stays legible under white text", () => {
    for (const seed of ["a@b.com", "z@q.io", "team@abeon.hosting", "j", ""]) {
      const l = lightness(senderAvatarColor(seed, "#4f46e5"));
      expect(l).toBeGreaterThanOrEqual(39);
      expect(l).toBeLessThanOrEqual(65);
    }
  });
  it("follows the accent: a different accent yields a different color", () => {
    expect(senderAvatarColor("a@b.com", "#4f46e5")).not.toBe(
      senderAvatarColor("a@b.com", "#10b981")
    );
  });
});

describe("deriveAccentVars", () => {
  it("echoes the accent and derives a hover shade and shadow", () => {
    const vars = deriveAccentVars("#4f46e5");
    expect(vars.accent).toBe("#4f46e5");
    expect(vars.accentHover).toMatch(/^#[0-9a-f]{6}$/i);
    expect(vars.accentHover).not.toBe("#4f46e5");
    expect(vars.shadowAccent).toBe("0 6px 14px -6px rgba(79, 70, 229, 0.6)");
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
  it("parses the smart folders master toggle", () => {
    expect(parseSettings([["appearance.smartFoldersEnabled", "false"]]).smartFoldersEnabled).toBe(false);
    expect(parseSettings([["appearance.smartFoldersEnabled", "true"]]).smartFoldersEnabled).toBe(true);
  });
  it("leaves smartFoldersEnabled undefined for a bogus boolean value", () => {
    expect(parseSettings([["appearance.smartFoldersEnabled", "garbage"]]).smartFoldersEnabled).toBeUndefined();
  });
  it("merges partial smart folder visibility onto the all-visible default", () => {
    const parsed = parseSettings([["appearance.smartFolderVisibility", JSON.stringify({ flagged: false })]]);
    expect(parsed.smartFolderVisibility).toEqual({
      all_inboxes: true,
      unread: true,
      flagged: false,
      snoozed: true,
    });
  });
  it("ignores unknown kinds and non-boolean values inside the visibility map", () => {
    const parsed = parseSettings([
      ["appearance.smartFolderVisibility", JSON.stringify({ unread: false, flagged: "nope", bogus: true })],
    ]);
    expect(parsed.smartFolderVisibility).toEqual({
      all_inboxes: true,
      unread: false,
      flagged: true,
      snoozed: true,
    });
  });
  it("leaves smartFolderVisibility undefined for malformed JSON", () => {
    const parsed = parseSettings([["appearance.smartFolderVisibility", "{not json"]]);
    expect(parsed.smartFolderVisibility).toBeUndefined();
  });
});

describe("DEFAULT_APPEARANCE", () => {
  it("defaults theme auto, accent indigo, density comfortable, toggles on, all smart folders shown", () => {
    expect(DEFAULT_APPEARANCE).toEqual({
      theme: "auto",
      accent: "#4f46e5",
      density: "comfortable",
      showPreview: true,
      showAvatars: true,
      smartFoldersEnabled: true,
      smartFolderVisibility: {
        all_inboxes: true,
        unread: true,
        flagged: true,
        snoozed: true,
      },
    });
  });
});
