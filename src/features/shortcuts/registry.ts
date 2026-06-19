export type ActionContext = "global" | "list" | "reader" | "composer";

export type ActionId =
  | "command-palette"
  | "cheat-sheet"
  | "compose"
  | "go-inbox"
  | "go-starred"
  | "open-settings"
  | "search"
  | "next-message"
  | "prev-message"
  | "first-message"
  | "last-message"
  | "reply"
  | "reply-all"
  | "forward"
  | "back-to-list"
  | "toggle-flag"
  | "mark-read"
  | "mark-unread"
  | "send-message"
  | "close-composer"
  | "archive"
  | "delete"
  | "snooze"
  | "label";

export type ActionMeta = {
  id: ActionId;
  label: string;
  contexts: ActionContext[];
  defaultBinding: string;
  enabled: boolean;
};

export const ACTIONS: ActionMeta[] = [
  { id: "command-palette", label: "Command palette", contexts: ["global"], defaultBinding: "Mod+k", enabled: true },
  { id: "cheat-sheet", label: "Keyboard shortcuts", contexts: ["global"], defaultBinding: "?", enabled: true },
  { id: "compose", label: "Compose", contexts: ["global"], defaultBinding: "c", enabled: true },
  { id: "go-inbox", label: "Go to All Inboxes", contexts: ["global"], defaultBinding: "g i", enabled: true },
  { id: "go-starred", label: "Go to Flagged", contexts: ["global"], defaultBinding: "g s", enabled: true },
  { id: "open-settings", label: "Settings", contexts: ["global"], defaultBinding: "g ,", enabled: true },
  { id: "search", label: "Search mail", contexts: ["global"], defaultBinding: "/", enabled: true },
  { id: "next-message", label: "Next message", contexts: ["list", "reader"], defaultBinding: "j", enabled: true },
  { id: "prev-message", label: "Previous message", contexts: ["list", "reader"], defaultBinding: "k", enabled: true },
  { id: "first-message", label: "First message", contexts: ["list", "reader"], defaultBinding: "", enabled: true },
  { id: "last-message", label: "Last message", contexts: ["list", "reader"], defaultBinding: "", enabled: true },
  { id: "reply", label: "Reply", contexts: ["reader"], defaultBinding: "r", enabled: true },
  { id: "reply-all", label: "Reply all", contexts: ["reader"], defaultBinding: "a", enabled: true },
  { id: "forward", label: "Forward", contexts: ["reader"], defaultBinding: "f", enabled: true },
  { id: "back-to-list", label: "Back to list", contexts: ["reader"], defaultBinding: "u", enabled: true },
  { id: "toggle-flag", label: "Toggle flag", contexts: ["reader"], defaultBinding: "s", enabled: true },
  { id: "mark-read", label: "Mark read", contexts: ["reader"], defaultBinding: "I", enabled: true },
  { id: "mark-unread", label: "Mark unread", contexts: ["reader"], defaultBinding: "U", enabled: true },
  { id: "send-message", label: "Send", contexts: ["composer"], defaultBinding: "Mod+Enter", enabled: true },
  { id: "close-composer", label: "Close composer", contexts: ["composer"], defaultBinding: "Escape", enabled: true },
  { id: "archive", label: "Archive", contexts: ["reader"], defaultBinding: "e", enabled: false },
  { id: "delete", label: "Delete", contexts: ["reader"], defaultBinding: "#", enabled: false },
  { id: "snooze", label: "Snooze", contexts: ["reader", "list"], defaultBinding: "b", enabled: true },
  { id: "label", label: "Label", contexts: ["reader", "list"], defaultBinding: "l", enabled: true },
];

const BY_ID = new Map<ActionId, ActionMeta>(ACTIONS.map((a) => [a.id, a]));

export function actionById(id: ActionId): ActionMeta | undefined {
  return BY_ID.get(id);
}
