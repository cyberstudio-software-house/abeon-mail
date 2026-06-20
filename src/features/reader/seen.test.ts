import { describe, it, expect } from "vitest";
import { seenIdsForBulk } from "./seen";

const msgs = [
  { id: 1, seen: true },
  { id: 2, seen: false },
  { id: 3, seen: false },
];

describe("seenIdsForBulk", () => {
  it("returns only unread ids when marking read", () => {
    expect(seenIdsForBulk(msgs, true)).toEqual([2, 3]);
  });

  it("returns all ids when marking unread", () => {
    expect(seenIdsForBulk(msgs, false)).toEqual([1, 2, 3]);
  });

  it("returns [] for empty or undefined input", () => {
    expect(seenIdsForBulk([], true)).toEqual([]);
    expect(seenIdsForBulk(undefined, false)).toEqual([]);
  });
});
