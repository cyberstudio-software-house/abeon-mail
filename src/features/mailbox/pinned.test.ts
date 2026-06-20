import { describe, it, expect } from "vitest";
import type { Account, Folder } from "../../ipc/bindings";
import {
  pinKey,
  parsePinnedMap,
  togglePinnedIds,
  isFolderPinned,
  selectInboxes,
  selectPinnedByAccount,
} from "./pinned";

function account(id: number, email = `a${id}@x.pl`): Account {
  return {
    id,
    email,
    display_name: `Account ${id}`,
    provider_type: "imap_password",
    color: null,
    position: id,
    requires_reauth: false,
  };
}

function folder(id: number, accountId: number, name: string, folder_type: Folder["folder_type"]): Folder {
  return {
    id,
    account_id: accountId,
    remote_path: name,
    name,
    folder_type,
    unread_count: 0,
    total_count: 0,
  };
}

describe("pinned helpers", () => {
  it("builds the per-account settings key", () => {
    expect(pinKey(7)).toBe("folders.pinned.7");
  });

  it("parses only pinned settings entries into a map", () => {
    const map = parsePinnedMap([
      ["folders.pinned.1", "[3,5]"],
      ["images.autoload.1", "true"],
      ["folders.pinned.2", "[9]"],
      ["folders.pinned.3", "not-json"],
    ]);
    expect(map.get(1)).toEqual([3, 5]);
    expect(map.get(2)).toEqual([9]);
    expect(map.has(3)).toBe(false);
  });

  it("toggles a folder id in and out of the list", () => {
    expect(togglePinnedIds([3, 5], 7)).toEqual([3, 5, 7]);
    expect(togglePinnedIds([3, 5, 7], 5)).toEqual([3, 7]);
  });

  it("reports pinned state for an account folder", () => {
    const map = new Map<number, number[]>([[1, [5]]]);
    expect(isFolderPinned(map, 1, 5)).toBe(true);
    expect(isFolderPinned(map, 1, 9)).toBe(false);
    expect(isFolderPinned(map, 2, 5)).toBe(false);
  });

  it("selects the inbox folder per account, skipping accounts without one", () => {
    const accounts = [account(1), account(2)];
    const byAccount = new Map<number, Folder[]>([
      [1, [folder(10, 1, "INBOX", "inbox"), folder(11, 1, "Work", "custom")]],
      [2, [folder(20, 2, "Sent", "sent")]],
    ]);
    const entries = selectInboxes(accounts, byAccount);
    expect(entries).toHaveLength(1);
    expect(entries[0].account.id).toBe(1);
    expect(entries[0].inbox.id).toBe(10);
  });

  it("groups pinned folders per account, sorted, excluding inbox and empty groups", () => {
    const accounts = [account(1), account(2), account(3)];
    const byAccount = new Map<number, Folder[]>([
      [1, [
        folder(10, 1, "INBOX", "inbox"),
        folder(11, 1, "Zlecenia", "custom"),
        folder(12, 1, "Archiwum", "archive"),
        folder(13, 1, "Nieprzypięty", "custom"),
      ]],
      [2, [folder(20, 2, "INBOX", "inbox")]],
      [3, []],
    ]);
    const pinnedMap = new Map<number, number[]>([
      [1, [11, 12, 10]],
      [2, [20]],
    ]);
    const groups = selectPinnedByAccount(accounts, byAccount, pinnedMap);
    expect(groups).toHaveLength(1);
    expect(groups[0].account.id).toBe(1);
    expect(groups[0].folders.map((f) => f.id)).toEqual([12, 11]);
  });
});
