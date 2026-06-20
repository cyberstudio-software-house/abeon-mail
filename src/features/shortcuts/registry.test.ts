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

  it("archive and delete are enabled in reader and list", () => {
    for (const id of ["archive", "delete"] as ActionId[]) {
      const a = actionById(id);
      expect(a?.enabled).toBe(true);
      expect(a?.contexts).toContain("reader");
      expect(a?.contexts).toContain("list");
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

describe("snooze action", () => {
  it("snooze action is enabled and available in reader and list", () => {
    const snooze = ACTIONS.find((a) => a.id === "snooze")!;
    expect(snooze.enabled).toBe(true);
    expect(snooze.contexts).toContain("reader");
    expect(snooze.contexts).toContain("list");
    expect(snooze.defaultBinding).toBe("b");
  });
});
