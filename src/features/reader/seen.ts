export type SeenState = { id: number; seen: boolean };

export function seenIdsForBulk(messages: SeenState[] | undefined, value: boolean): number[] {
  if (!messages || messages.length === 0) return [];
  return value ? messages.filter((m) => !m.seen).map((m) => m.id) : messages.map((m) => m.id);
}
