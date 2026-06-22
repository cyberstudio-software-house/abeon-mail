import type { SmartFolderKind } from "../ipc/bindings";

export const SMART_FOLDER_META: { kind: SmartFolderKind; label: string }[] = [
  { kind: "all_inboxes", label: "All Inboxes" },
  { kind: "unread", label: "Unread" },
  { kind: "flagged", label: "Flagged" },
  { kind: "snoozed", label: "Snoozed" },
];

export type SmartFolderVisibility = Record<SmartFolderKind, boolean>;

export const DEFAULT_SMART_FOLDER_VISIBILITY: SmartFolderVisibility = {
  all_inboxes: true,
  unread: true,
  flagged: true,
  snoozed: true,
};
