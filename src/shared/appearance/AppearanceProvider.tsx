import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { resolveTheme, type ThemeMode } from "../theme/theme";
import {
  SETTINGS_KEYS,
  parseSettings,
  type AppearanceFields,
  type Density,
} from "./appearance";

type AppearanceContextValue = AppearanceFields & {
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: string) => void;
  setDensity: (density: Density) => void;
  setShowPreview: (value: boolean) => void;
  setShowAvatars: (value: boolean) => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function persist(key: string, value: string) {
  void commands.setSetting(key, value).catch(() => undefined);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const theme = useUiStore((s) => s.theme);
  const accent = useUiStore((s) => s.accent);
  const density = useUiStore((s) => s.density);
  const showPreview = useUiStore((s) => s.showPreview);
  const showAvatars = useUiStore((s) => s.showAvatars);
  const hydrateAppearance = useUiStore((s) => s.hydrateAppearance);
  const storeSetTheme = useUiStore((s) => s.setTheme);
  const storeSetAccent = useUiStore((s) => s.setAccent);
  const storeSetDensity = useUiStore((s) => s.setDensity);
  const storeSetShowPreview = useUiStore((s) => s.setShowPreview);
  const storeSetShowAvatars = useUiStore((s) => s.setShowAvatars);

  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (!active) return;
        if (res.status === "ok") {
          hydrateAppearance(parseSettings(res.data as [string, string][]));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrateAppearance]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(theme, prefersDark);
  }, [theme, prefersDark]);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", accent);
  }, [accent]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      theme,
      accent,
      density,
      showPreview,
      showAvatars,
      setTheme: (t) => {
        storeSetTheme(t);
        persist(SETTINGS_KEYS.theme, t);
      },
      setAccent: (a) => {
        storeSetAccent(a);
        persist(SETTINGS_KEYS.accent, a);
      },
      setDensity: (d) => {
        storeSetDensity(d);
        persist(SETTINGS_KEYS.density, d);
      },
      setShowPreview: (v) => {
        storeSetShowPreview(v);
        persist(SETTINGS_KEYS.showPreview, String(v));
      },
      setShowAvatars: (v) => {
        storeSetShowAvatars(v);
        persist(SETTINGS_KEYS.showAvatars, String(v));
      },
    }),
    [
      theme,
      accent,
      density,
      showPreview,
      showAvatars,
      storeSetTheme,
      storeSetAccent,
      storeSetDensity,
      storeSetShowPreview,
      storeSetShowAvatars,
    ]
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance must be used within AppearanceProvider");
  return ctx;
}
