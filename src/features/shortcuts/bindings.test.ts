import { describe, it, expect } from "vitest";
import {
  eventToStep,
  resolveBindings,
  bindingsConflict,
  conflictFor,
  prettyBinding,
  parseShortcutSettings,
  SHORTCUT_KEYS,
} from "./bindings";

describe("eventToStep", () => {
  it("plain key", () => {
    expect(eventToStep({ key: "g", metaKey: false, ctrlKey: false })).toBe("g");
  });
  it("shift-produced char encoded by the character itself", () => {
    expect(eventToStep({ key: "I", metaKey: false, ctrlKey: false })).toBe("I");
    expect(eventToStep({ key: "?", metaKey: false, ctrlKey: false })).toBe("?");
  });
  it("ctrl/meta becomes Mod prefix", () => {
    expect(eventToStep({ key: "k", metaKey: false, ctrlKey: true })).toBe("Mod+k");
    expect(eventToStep({ key: "Enter", metaKey: true, ctrlKey: false })).toBe("Mod+Enter");
  });
});

describe("resolveBindings", () => {
  it("default profile uses each action's default binding", () => {
    const r = resolveBindings("default", {});
    expect(r["compose"]).toBe("c");
    expect(r["command-palette"]).toBe("Mod+k");
  });
  it("empty default binding resolves to null", () => {
    expect(resolveBindings("default", {})["first-message"]).toBeNull();
  });
  it("vim profile binds first/last message", () => {
    const r = resolveBindings("vim", {});
    expect(r["first-message"]).toBe("g g");
    expect(r["last-message"]).toBe("G");
    expect(r["next-message"]).toBe("j");
  });
  it("overrides win and null means unbound", () => {
    const r = resolveBindings("default", { compose: "n", reply: null });
    expect(r["compose"]).toBe("n");
    expect(r["reply"]).toBeNull();
  });
  it("ignores unknown override ids", () => {
    const r = resolveBindings("default", { "not-an-action": "z" });
    expect(r["compose"]).toBe("c");
  });
});

describe("bindingsConflict", () => {
  it("equal bindings conflict", () => {
    expect(bindingsConflict("c", "c")).toBe(true);
  });
  it("a sequence prefix conflicts", () => {
    expect(bindingsConflict("g", "g i")).toBe(true);
    expect(bindingsConflict("g i", "g")).toBe(true);
  });
  it("disjoint bindings do not conflict", () => {
    expect(bindingsConflict("g i", "g s")).toBe(false);
    expect(bindingsConflict("c", "r")).toBe(false);
  });
});

describe("conflictFor", () => {
  it("finds the action currently holding a conflicting binding", () => {
    const resolved = resolveBindings("default", {});
    expect(conflictFor("c", resolved, "reply")).toBe("compose");
  });
  it("excludes the action being edited and skips null", () => {
    const resolved = resolveBindings("default", { reply: null });
    expect(conflictFor("c", resolved, "compose")).toBeNull();
  });
});

describe("prettyBinding", () => {
  it("renders Mod and shift letters", () => {
    expect(prettyBinding("Mod+k", true)).toBe("⌘K");
    expect(prettyBinding("Mod+k", false)).toBe("Ctrl+K");
    expect(prettyBinding("I", false)).toBe("Shift+I");
    expect(prettyBinding("g i", false)).toBe("G then I");
  });
});

describe("parseShortcutSettings", () => {
  it("parses profile and overrides JSON, dropping junk", () => {
    const parsed = parseShortcutSettings([
      [SHORTCUT_KEYS.profile, "vim"],
      [SHORTCUT_KEYS.overrides, JSON.stringify({ compose: "n", bogus: "z", reply: null })],
    ]);
    expect(parsed.profile).toBe("vim");
    expect(parsed.overrides).toEqual({ compose: "n", reply: null });
  });
  it("rejects an invalid profile and malformed JSON", () => {
    const parsed = parseShortcutSettings([
      [SHORTCUT_KEYS.profile, "emacs"],
      [SHORTCUT_KEYS.overrides, "{not json"],
    ]);
    expect(parsed.profile).toBeUndefined();
    expect(parsed.overrides).toBeUndefined();
  });
});
