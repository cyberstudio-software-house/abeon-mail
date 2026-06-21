const BODIES_KEY_PREFIX = "prefetch.bodies.";
const FOLDERS_KEY_PREFIX = "prefetch.folders.";

export function prefetchBodiesKey(accountId: number): string {
  return `${BODIES_KEY_PREFIX}${accountId}`;
}

export function prefetchFoldersKey(accountId: number): string {
  return `${FOLDERS_KEY_PREFIX}${accountId}`;
}

export function parsePrefetchFoldersMap(settings: [string, string][]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const [key, value] of settings) {
    if (!key.startsWith(FOLDERS_KEY_PREFIX)) continue;
    const accountId = Number(key.slice(FOLDERS_KEY_PREFIX.length));
    if (!Number.isInteger(accountId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      map.set(accountId, parsed.filter((x): x is number => typeof x === "number"));
    }
  }
  return map;
}

export function togglePrefetchedIds(ids: number[], folderId: number): number[] {
  return ids.includes(folderId) ? ids.filter((id) => id !== folderId) : [...ids, folderId];
}

export function isFolderPrefetched(
  map: Map<number, number[]>,
  accountId: number,
  folderId: number,
): boolean {
  return map.get(accountId)?.includes(folderId) ?? false;
}

export function parseAccountPrefetch(settings: [string, string][], accountId: number): boolean {
  const key = prefetchBodiesKey(accountId);
  const found = settings.find(([k]) => k === key);
  return found ? found[1] === "true" : false;
}
