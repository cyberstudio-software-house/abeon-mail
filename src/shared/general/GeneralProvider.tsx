import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { GENERAL_KEYS, parseGeneralSettings, type TimeFormat } from "./general";

type GeneralContextValue = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
  setDefaultAccountId: (value: string) => void;
  setTimeFormat: (value: TimeFormat) => void;
};

const GeneralContext = createContext<GeneralContextValue | null>(null);

function persist(key: string, value: string) {
  void commands.setSetting(key, value).catch(() => undefined);
}

export function GeneralProvider({ children }: { children: ReactNode }) {
  const defaultAccountId = useUiStore((s) => s.defaultAccountId);
  const timeFormat = useUiStore((s) => s.timeFormat);
  const hydrateGeneral = useUiStore((s) => s.hydrateGeneral);
  const storeSetDefaultAccountId = useUiStore((s) => s.setDefaultAccountId);
  const storeSetTimeFormat = useUiStore((s) => s.setTimeFormat);

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
      setDefaultAccountId: (v) => {
        storeSetDefaultAccountId(v);
        persist(GENERAL_KEYS.defaultAccountId, v);
      },
      setTimeFormat: (v) => {
        storeSetTimeFormat(v);
        persist(GENERAL_KEYS.timeFormat, v);
      },
    }),
    [defaultAccountId, timeFormat, storeSetDefaultAccountId, storeSetTimeFormat]
  );

  return <GeneralContext.Provider value={value}>{children}</GeneralContext.Provider>;
}

export function useGeneral(): GeneralContextValue {
  const ctx = useContext(GeneralContext);
  if (!ctx) throw new Error("useGeneral must be used within GeneralProvider");
  return ctx;
}
