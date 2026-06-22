export function selectNextAfterRemoval(
  visibleIds: number[],
  removedIds: number[]
): number | null {
  const removed = new Set(removedIds);

  let lastRemovedIndex = -1;
  for (let i = 0; i < visibleIds.length; i++) {
    if (removed.has(visibleIds[i])) lastRemovedIndex = i;
  }
  if (lastRemovedIndex === -1) return null;

  for (let i = lastRemovedIndex + 1; i < visibleIds.length; i++) {
    if (!removed.has(visibleIds[i])) return visibleIds[i];
  }
  for (let i = lastRemovedIndex - 1; i >= 0; i--) {
    if (!removed.has(visibleIds[i])) return visibleIds[i];
  }
  return null;
}
