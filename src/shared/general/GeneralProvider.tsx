import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { GENERAL_KEYS, parseGeneralSettings, type TimeFormat, type MarkReadMode, type ThreadOrder } from "./general";

type GeneralContextValue = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
  markReadMode: MarkReadMode;
  markReadDelaySeconds: number;
  threadOrder: ThreadOrder;
  setDefaultAccountId: (value: string) => void;
  setTimeFormat: (value: TimeFormat) => void;
  setMarkReadMode: (value: MarkReadMode) => void;
  setMarkReadDelaySeconds: (value: number) => void;
  setThreadOrder: (value: ThreadOrder) => void;
};

const GeneralContext = createContext<GeneralContextValue | null>(null);

function persist(key: string, value: string) {
  void commands.setSetting(key, value).catch(() => undefined);
}

export function GeneralProvider({ children }: { children: ReactNode }) {
  const defaultAccountId = useUiStore((s) => s.defaultAccountId);
  const timeFormat = useUiStore((s) => s.timeFormat);
  const hydrateGeneral = useUiStore((s) => s.hydrateGeneral);
  const markReadMode = useUiStore((s) => s.markReadMode);
  const markReadDelaySeconds = useUiStore((s) => s.markReadDelaySeconds);
  const threadOrder = useUiStore((s) => s.threadOrder);
  const storeSetDefaultAccountId = useUiStore((s) => s.setDefaultAccountId);
  const storeSetTimeFormat = useUiStore((s) => s.setTimeFormat);
  const storeSetMarkReadMode = useUiStore((s) => s.setMarkReadMode);
  const storeSetMarkReadDelaySeconds = useUiStore((s) => s.setMarkReadDelaySeconds);
  const storeSetThreadOrder = useUiStore((s) => s.setThreadOrder);

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (!active) return;
        hydrateGeneral(res.status === "ok" ? parseGeneralSettings(res.data) : {});
      })
      .catch(() => {
        if (active) hydrateGeneral({});
      });
    return () => {
      active = false;
    };
  }, [hydrateGeneral]);

  const value = useMemo<GeneralContextValue>(
    () => ({
      defaultAccountId,
      timeFormat,
      markReadMode,
      markReadDelaySeconds,
      threadOrder,
      setDefaultAccountId: (v) => {
        storeSetDefaultAccountId(v);
        persist(GENERAL_KEYS.defaultAccountId, v);
      },
      setTimeFormat: (v) => {
        storeSetTimeFormat(v);
        persist(GENERAL_KEYS.timeFormat, v);
      },
      setMarkReadMode: (v) => {
        storeSetMarkReadMode(v);
        persist(GENERAL_KEYS.markReadMode, v);
      },
      setMarkReadDelaySeconds: (v) => {
        storeSetMarkReadDelaySeconds(v);
        persist(GENERAL_KEYS.markReadDelaySeconds, String(v));
      },
      setThreadOrder: (v) => {
        storeSetThreadOrder(v);
        persist(GENERAL_KEYS.threadOrder, v);
      },
    }),
    [
      defaultAccountId,
      timeFormat,
      markReadMode,
      markReadDelaySeconds,
      threadOrder,
      storeSetDefaultAccountId,
      storeSetTimeFormat,
      storeSetMarkReadMode,
      storeSetMarkReadDelaySeconds,
      storeSetThreadOrder,
    ]
  );

  return <GeneralContext.Provider value={value}>{children}</GeneralContext.Provider>;
}

export function useGeneral(): GeneralContextValue {
  const ctx = useContext(GeneralContext);
  if (!ctx) throw new Error("useGeneral must be used within GeneralProvider");
  return ctx;
}
