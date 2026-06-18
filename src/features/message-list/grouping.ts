export type GroupLabel = "Today" | "Yesterday" | "Earlier";

export type ListEntry<T> =
  | { kind: "header"; label: GroupLabel }
  | { kind: "item"; data: T };

function startOfDay(epochSeconds: number): number {
  const d = new Date(epochSeconds * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function groupLabel(epochSeconds: number, nowSeconds: number): GroupLabel {
  const today = startOfDay(nowSeconds);
  const day = startOfDay(epochSeconds);
  const oneDay = 86400;
  if (day >= today) return "Today";
  if (day >= today - oneDay) return "Yesterday";
  return "Earlier";
}

export function groupIntoEntries<T>(
  items: T[],
  getDate: (item: T) => number,
  nowSeconds: number
): ListEntry<T>[] {
  const entries: ListEntry<T>[] = [];
  let current: GroupLabel | null = null;
  for (const item of items) {
    const label = groupLabel(getDate(item), nowSeconds);
    if (label !== current) {
      entries.push({ kind: "header", label });
      current = label;
    }
    entries.push({ kind: "item", data: item });
  }
  return entries;
}
