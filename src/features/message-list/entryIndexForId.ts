import type { ListEntry } from "./grouping";

export function entryIndexForId<T>(
  entries: ListEntry<T>[],
  id: number | null,
  getId: (item: T) => number
): number {
  if (id == null) return -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.kind === "item" && getId(entry.data) === id) return i;
  }
  return -1;
}
