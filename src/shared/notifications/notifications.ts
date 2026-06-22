export type NotificationFields = {
  notificationsEnabled: boolean;
  badgeEnabled: boolean;
  trayEnabled: boolean;
};

export const NOTIFICATION_KEYS = {
  notificationsEnabled: "notifications.enabled",
  badgeEnabled: "notifications.badge",
  tray: "notifications.tray",
} as const;

export const DEFAULT_NOTIFICATIONS: NotificationFields = {
  notificationsEnabled: true,
  badgeEnabled: true,
  trayEnabled: false,
};

export function parseNotificationSettings(pairs: [string, string][]): Partial<NotificationFields> {
  const out: Partial<NotificationFields> = {};
  for (const [key, value] of pairs) {
    if (key === NOTIFICATION_KEYS.notificationsEnabled && (value === "true" || value === "false")) {
      out.notificationsEnabled = value === "true";
    } else if (key === NOTIFICATION_KEYS.badgeEnabled && (value === "true" || value === "false")) {
      out.badgeEnabled = value === "true";
    } else if (key === NOTIFICATION_KEYS.tray && (value === "true" || value === "false")) {
      out.trayEnabled = value === "true";
    }
  }
  return out;
}
