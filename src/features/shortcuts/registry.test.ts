import { describe, it, expect } from "vitest";
import { ACTIONS, actionById, type ActionId } from "./registry";

describe("ACTIONS registry", () => {
  it("has unique ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every action declares at least one context", () => {
    expect(ACTIONS.every((a) => a.contexts.length > 0)).toBe(true);
  });

  it("placeholder actions are disabled", () => {
    const disabled: ActionId[] = ["archive", "delete", "snooze"];
    for (const id of disabled) {
      expect(actionById(id)?.enabled).toBe(false);
    }
  });

  it("core actions are enabled with their default bindings", () => {
    expect(actionById("command-palette")).toMatchObject({ defaultBinding: "Mod+k", enabled: true });
    expect(actionById("compose")).toMatchObject({ defaultBinding: "c", enabled: true });
    expect(actionById("go-inbox")).toMatchObject({ defaultBinding: "g i", enabled: true });
    expect(actionById("mark-read")).toMatchObject({ defaultBinding: "I", enabled: true });
    expect(actionById("send-message")).toMatchObject({ defaultBinding: "Mod+Enter", enabled: true });
  });

  it("first-message/last-message have no default binding (vim-only)", () => {
    expect(actionById("first-message")?.defaultBinding).toBe("");
    expect(actionById("last-message")?.defaultBinding).toBe("");
  });
});

describe("search action", () => {
  it("is enabled and bound to /", () => {
    const search = actionById("search");
    expect(search?.enabled).toBe(true);
    expect(search?.defaultBinding).toBe("/");
  });
});

describe("label action", () => {
  it("label action is enabled and bound to l", () => {
    const a = actionById("label");
    expect(a?.enabled).toBe(true);
    expect(a?.defaultBinding).toBe("l");
  });
});
