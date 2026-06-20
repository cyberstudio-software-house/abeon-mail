import type { Account, Folder } from "../../ipc/bindings";
import { decodeImapUtf7 } from "./folder-tree";

const PIN_KEY_PREFIX = "folders.pinned.";

export function pinKey(accountId: number): string {
  return `${PIN_KEY_PREFIX}${accountId}`;
}

export function parsePinnedMap(settings: [string, string][]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const [key, value] of settings) {
    if (!key.startsWith(PIN_KEY_PREFIX)) continue;
    const accountId = Number(key.slice(PIN_KEY_PREFIX.length));
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

export function togglePinnedIds(ids: number[], folderId: number): number[] {
  return ids.includes(folderId) ? ids.filter((id) => id !== folderId) : [...ids, folderId];
}

export function isFolderPinned(
  pinnedMap: Map<number, number[]>,
  accountId: number,
  folderId: number,
): boolean {
  return pinnedMap.get(accountId)?.includes(folderId) ?? false;
}

export type InboxEntry = { account: Account; inbox: Folder };

export function selectInboxes(
  accounts: Account[],
  foldersByAccount: Map<number, Folder[]>,
): InboxEntry[] {
  const entries: InboxEntry[] = [];
  for (const account of accounts) {
    const folders = foldersByAccount.get(account.id) ?? [];
    const inbox = folders.find((f) => f.folder_type === "inbox");
    if (inbox) entries.push({ account, inbox });
  }
  return entries;
}

export type PinnedGroup = { account: Account; folders: Folder[] };

export function selectPinnedByAccount(
  accounts: Account[],
  foldersByAccount: Map<number, Folder[]>,
  pinnedMap: Map<number, number[]>,
): PinnedGroup[] {
  const groups: PinnedGroup[] = [];
  for (const account of accounts) {
    const ids = pinnedMap.get(account.id);
    if (!ids || ids.length === 0) continue;
    const idSet = new Set(ids);
    const folders = (foldersByAccount.get(account.id) ?? []).filter(
      (f) => idSet.has(f.id) && f.folder_type !== "inbox",
    );
    folders.sort((a, b) =>
      decodeImapUtf7(a.name).localeCompare(decodeImapUtf7(b.name), "pl", { sensitivity: "base" }),
    );
    if (folders.length > 0) groups.push({ account, folders });
  }
  return groups;
}
