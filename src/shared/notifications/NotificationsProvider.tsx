import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { NOTIFICATION_KEYS, parseNotificationSettings } from "./notifications";

type NotificationsContextValue = {
  notificationsEnabled: boolean;
  badgeEnabled: boolean;
  trayEnabled: boolean;
  permissionGranted: boolean;
  setNotificationsEnabled: (value: boolean) => void;
  setBadgeEnabled: (value: boolean) => void;
  setTrayEnabled: (value: boolean) => void;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

function persist(key: string, value: string) {
  void commands.setSetting(key, value).catch(() => undefined);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const notificationsEnabled = useUiStore((s) => s.notificationsEnabled);
  const badgeEnabled = useUiStore((s) => s.badgeEnabled);
  const trayEnabled = useUiStore((s) => s.trayEnabled);
  const hydrateNotifications = useUiStore((s) => s.hydrateNotifications);
  const storeSetNotificationsEnabled = useUiStore((s) => s.setNotificationsEnabled);
  const storeSetBadgeEnabled = useUiStore((s) => s.setBadgeEnabled);
  const storeSetTrayEnabled = useUiStore((s) => s.setTrayEnabled);
  const [permissionGranted, setPermissionGranted] = useState(true);

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (active && res.status === "ok") {
          hydrateNotifications(parseNotificationSettings(res.data));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrateNotifications]);

  useEffect(() => {
    if (!notificationsEnabled) return;
    let active = true;
    (async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      if (active) setPermissionGranted(granted);
    })();
    return () => {
      active = false;
    };
  }, [notificationsEnabled]);

  useEffect(() => {
    void commands.refreshUnreadBadge(badgeEnabled).catch(() => undefined);
  }, [badgeEnabled]);

  useEffect(() => {
    void commands.setTrayEnabled(trayEnabled).catch(() => undefined);
  }, [trayEnabled]);

  const value = useMemo<NotificationsContextValue>(
    () => ({
      notificationsEnabled,
      badgeEnabled,
      trayEnabled,
      permissionGranted,
      setNotificationsEnabled: (v) => {
        storeSetNotificationsEnabled(v);
        persist(NOTIFICATION_KEYS.notificationsEnabled, String(v));
      },
      setBadgeEnabled: (v) => {
        storeSetBadgeEnabled(v);
        persist(NOTIFICATION_KEYS.badgeEnabled, String(v));
      },
      setTrayEnabled: (v) => {
        storeSetTrayEnabled(v);
        persist(NOTIFICATION_KEYS.tray, String(v));
      },
    }),
    [
      notificationsEnabled,
      badgeEnabled,
      trayEnabled,
      permissionGranted,
      storeSetNotificationsEnabled,
      storeSetBadgeEnabled,
      storeSetTrayEnabled,
    ]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}
