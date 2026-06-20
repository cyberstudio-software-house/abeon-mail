import { useEffect, useState } from "react";
import { useUiStore } from "../../app/store";
import { AccountsSection } from "./AccountsSection";
import { AppearanceSection } from "./AppearanceSection";
import { LabelsSection } from "./LabelsSection";
import { NotificationsSection } from "./NotificationsSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { SignaturesSection } from "./SignaturesSection";
import { GeneralSection } from "./GeneralSection";
import { SnoozeSection } from "./SnoozeSection";
import { RulesSection } from "./RulesSection";
import "./Settings.css";

type SettingsSection =
  | "general"
  | "accounts"
  | "appearance"
  | "labels"
  | "signatures"
  | "notifications"
  | "rules"
  | "snooze"
  | "shortcuts";

const NAV: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "appearance", label: "Appearance" },
  { id: "labels", label: "Labels" },
  { id: "signatures", label: "Signatures" },
  { id: "notifications", label: "Notifications" },
  { id: "rules", label: "Rules & Filters" },
  { id: "snooze", label: "Snooze" },
  { id: "shortcuts", label: "Shortcuts" },
];

export function SettingsOverlay() {
  const closeSettings = useUiStore((s) => s.closeSettings);
  const [active, setActive] = useState<SettingsSection>("appearance");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeSettings]);

  const activeLabel = NAV.find((n) => n.id === active)?.label ?? "";

  return (
    <div className="settings-overlay" role="dialog" aria-label="Settings" aria-modal="true">
      <div className="settings-panel">
        <aside className="settings-nav">
          <div className="settings-nav__title">Settings</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`settings-nav__item${active === n.id ? " settings-nav__item--active" : ""}`}
              onClick={() => setActive(n.id)}
            >
              {n.label}
            </button>
          ))}
        </aside>
        <section className="settings-content">
          <header className="settings-content__header">
            <h2 className="settings-content__heading">{activeLabel}</h2>
            <button
              type="button"
              className="settings-content__close"
              aria-label="Close settings"
              onClick={closeSettings}
            >
              ✕
            </button>
          </header>
          {active === "general" ? (
            <GeneralSection />
          ) : active === "accounts" ? (
            <AccountsSection />
          ) : active === "appearance" ? (
            <AppearanceSection />
          ) : active === "labels" ? (
            <LabelsSection />
          ) : active === "signatures" ? (
            <SignaturesSection />
          ) : active === "notifications" ? (
            <NotificationsSection />
          ) : active === "snooze" ? (
            <SnoozeSection />
          ) : active === "rules" ? (
            <RulesSection />
          ) : active === "shortcuts" ? (
            <ShortcutsSection />
          ) : (
            <div className="settings-placeholder">Coming soon</div>
          )}
        </section>
      </div>
    </div>
  );
}
