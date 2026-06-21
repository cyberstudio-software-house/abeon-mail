import { describe, expect, it } from "vitest";
import {
  isFolderPrefetched,
  parseAccountPrefetch,
  parsePrefetchFoldersMap,
  prefetchBodiesKey,
  prefetchFoldersKey,
  togglePrefetchedIds,
} from "./prefetch";

describe("prefetch settings helpers", () => {
  it("builds per-account keys", () => {
    expect(prefetchBodiesKey(5)).toBe("prefetch.bodies.5");
    expect(prefetchFoldersKey(5)).toBe("prefetch.folders.5");
  });

  it("parses the folders map and ignores junk", () => {
    const map = parsePrefetchFoldersMap([
      ["prefetch.folders.1", "[3,7]"],
      ["prefetch.folders.2", "not json"],
      ["other", "x"],
    ]);
    expect(map.get(1)).toEqual([3, 7]);
    expect(isFolderPrefetched(map, 1, 3)).toBe(true);
    expect(isFolderPrefetched(map, 1, 9)).toBe(false);
    expect(isFolderPrefetched(map, 2, 1)).toBe(false);
  });

  it("toggles folder ids", () => {
    expect(togglePrefetchedIds([3], 7)).toEqual([3, 7]);
    expect(togglePrefetchedIds([3, 7], 7)).toEqual([3]);
  });

  it("parses the master toggle", () => {
    expect(parseAccountPrefetch([["prefetch.bodies.1", "true"]], 1)).toBe(true);
    expect(parseAccountPrefetch([["prefetch.bodies.1", "false"]], 1)).toBe(false);
    expect(parseAccountPrefetch([], 1)).toBe(false);
  });
});
