import { describe, it, expect } from "vitest";
import {
  SMART_FOLDER_META,
  DEFAULT_SMART_FOLDER_VISIBILITY,
} from "./smartFolders";

describe("SMART_FOLDER_META", () => {
  it("lists the four smart folders in rail order with labels", () => {
    expect(SMART_FOLDER_META).toEqual([
      { kind: "all_inboxes", label: "All Inboxes" },
      { kind: "unread", label: "Unread" },
      { kind: "flagged", label: "Flagged" },
      { kind: "snoozed", label: "Snoozed" },
    ]);
  });
});

describe("DEFAULT_SMART_FOLDER_VISIBILITY", () => {
  it("makes every smart folder visible by default", () => {
    expect(DEFAULT_SMART_FOLDER_VISIBILITY).toEqual({
      all_inboxes: true,
      unread: true,
      flagged: true,
      snoozed: true,
    });
  });

  it("has an entry for every kind in SMART_FOLDER_META", () => {
    for (const { kind } of SMART_FOLDER_META) {
      expect(DEFAULT_SMART_FOLDER_VISIBILITY[kind]).toBe(true);
    }
  });
});
