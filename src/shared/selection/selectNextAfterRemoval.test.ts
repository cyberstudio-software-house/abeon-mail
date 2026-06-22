import { describe, it, expect } from "vitest";
import { selectNextAfterRemoval } from "./selectNextAfterRemoval";

describe("selectNextAfterRemoval", () => {
  const visible = [1, 2, 3, 4, 5];

  it("picks the row below when removing from the middle", () => {
    expect(selectNextAfterRemoval(visible, [3])).toBe(4);
  });

  it("picks the next row when removing the first", () => {
    expect(selectNextAfterRemoval(visible, [1])).toBe(2);
  });

  it("picks the row above when removing the last", () => {
    expect(selectNextAfterRemoval(visible, [5])).toBe(4);
  });

  it("picks the row below a removed contiguous block", () => {
    expect(selectNextAfterRemoval(visible, [2, 3, 4])).toBe(5);
  });

  it("picks the row above a removed block at the bottom", () => {
    expect(selectNextAfterRemoval(visible, [4, 5])).toBe(3);
  });

  it("returns null when every row is removed", () => {
    expect(selectNextAfterRemoval(visible, [1, 2, 3, 4, 5])).toBeNull();
  });

  it("uses the last removed position for a non-contiguous bulk selection", () => {
    expect(selectNextAfterRemoval(visible, [2, 4])).toBe(5);
  });

  it("returns null when nothing was removed", () => {
    expect(selectNextAfterRemoval(visible, [])).toBeNull();
  });

  it("returns null when removed ids are not in the list", () => {
    expect(selectNextAfterRemoval(visible, [99])).toBeNull();
  });
});
