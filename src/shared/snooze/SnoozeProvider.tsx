import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { SNOOZE_KEYS, parseSnoozeSettings } from "./snooze";

type SnoozeContextValue = {
  morningHour: number;
  laterTodayHours: number;
  weekendDay: number;
  weekStartDay: number;
  setMorningHour: (value: number) => void;
  setLaterTodayHours: (value: number) => void;
  setWeekendDay: (value: number) => void;
  setWeekStartDay: (value: number) => void;
};

const SnoozeContext = createContext<SnoozeContextValue | null>(null);

function persist(key: string, value: number) {
  void commands.setSetting(key, String(value)).catch(() => undefined);
}

export function SnoozeProvider({ children }: { children: ReactNode }) {
  const morningHour = useUiStore((s) => s.snoozeMorningHour);
  const laterTodayHours = useUiStore((s) => s.snoozeLaterTodayHours);
  const weekendDay = useUiStore((s) => s.snoozeWeekendDay);
  const weekStartDay = useUiStore((s) => s.snoozeWeekStartDay);
  const hydrateSnooze = useUiStore((s) => s.hydrateSnooze);
  const storeSetMorningHour = useUiStore((s) => s.setSnoozeMorningHour);
  const storeSetLaterTodayHours = useUiStore((s) => s.setSnoozeLaterTodayHours);
  const storeSetWeekendDay = useUiStore((s) => s.setSnoozeWeekendDay);
  const storeSetWeekStartDay = useUiStore((s) => s.setSnoozeWeekStartDay);

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (!active) return;
        if (res.status === "ok") hydrateSnooze(parseSnoozeSettings(res.data));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrateSnooze]);

  const value = useMemo<SnoozeContextValue>(
    () => ({
      morningHour,
      laterTodayHours,
      weekendDay,
      weekStartDay,
      setMorningHour: (v) => {
        storeSetMorningHour(v);
        persist(SNOOZE_KEYS.morningHour, v);
      },
      setLaterTodayHours: (v) => {
        storeSetLaterTodayHours(v);
        persist(SNOOZE_KEYS.laterTodayHours, v);
      },
      setWeekendDay: (v) => {
        storeSetWeekendDay(v);
        persist(SNOOZE_KEYS.weekendDay, v);
      },
      setWeekStartDay: (v) => {
        storeSetWeekStartDay(v);
        persist(SNOOZE_KEYS.weekStartDay, v);
      },
    }),
    [
      morningHour,
      laterTodayHours,
      weekendDay,
      weekStartDay,
      storeSetMorningHour,
      storeSetLaterTodayHours,
      storeSetWeekendDay,
      storeSetWeekStartDay,
    ]
  );

  return <SnoozeContext.Provider value={value}>{children}</SnoozeContext.Provider>;
}

export function useSnoozeSettings(): SnoozeContextValue {
  const ctx = useContext(SnoozeContext);
  if (!ctx) throw new Error("useSnoozeSettings must be used within SnoozeProvider");
  return ctx;
}
