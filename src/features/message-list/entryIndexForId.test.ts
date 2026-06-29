import { describe, it, expect } from "vitest";
import { entryIndexForId } from "./entryIndexForId";
import type { ListEntry } from "./grouping";

type Row = { id: number };

const entries: ListEntry<Row>[] = [
  { kind: "header", label: "Today" },
  { kind: "item", data: { id: 10 } },
  { kind: "item", data: { id: 11 } },
  { kind: "header", label: "Yesterday" },
  { kind: "item", data: { id: 12 } },
];

const getId = (r: Row) => r.id;

describe("entryIndexForId", () => {
  it("returns the entry index accounting for header rows", () => {
    expect(entryIndexForId(entries, 11, getId)).toBe(2);
    expect(entryIndexForId(entries, 12, getId)).toBe(4);
  });

  it("returns -1 when the id is null", () => {
    expect(entryIndexForId(entries, null, getId)).toBe(-1);
  });

  it("returns -1 when the id is not present", () => {
    expect(entryIndexForId(entries, 999, getId)).toBe(-1);
  });
});
