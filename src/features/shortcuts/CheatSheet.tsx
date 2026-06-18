import { useEffect } from "react";
import { useShortcuts } from "./ShortcutsProvider";
import { ACTIONS, type ActionContext } from "./registry";
import { prettyBinding } from "./bindings";
import { useUiStore } from "../../app/store";
import "./CheatSheet.css";

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

const GROUPS: { context: ActionContext; title: string }[] = [
  { context: "global", title: "Global" },
  { context: "list", title: "Message list" },
  { context: "reader", title: "Reader" },
  { context: "composer", title: "Composer" },
];

export function CheatSheet() {
  const open = useUiStore((s) => s.cheatSheetOpen);
  const closeCheatSheet = useUiStore((s) => s.closeCheatSheet);
  const { resolved } = useShortcuts();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCheatSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeCheatSheet]);

  if (!open) return null;

  return (
    <div className="cheat-overlay" role="dialog" aria-label="Keyboard shortcuts" aria-modal="true">
      <div className="cheat-panel">
        <header className="cheat-header">
          <h2 className="cheat-title">Keyboard shortcuts</h2>
          <button type="button" className="cheat-close" aria-label="Close shortcuts" onClick={closeCheatSheet}>
            ✕
          </button>
        </header>
        <div className="cheat-columns">
          {GROUPS.map((g) => {
            const rows = ACTIONS.filter((a) => a.contexts.includes(g.context));
            if (rows.length === 0) return null;
            return (
              <section key={g.context} className="cheat-section">
                <h3 className="cheat-section__title">{g.title}</h3>
                {rows.map((a) => {
                  const binding = resolved[a.id];
                  return (
                    <div key={a.id} className={`cheat-row${a.enabled ? "" : " cheat-row--disabled"}`}>
                      <span className="cheat-row__label">{a.label}</span>
                      {a.enabled ? (
                        binding ? (
                          <kbd className="cheat-row__kbd">{prettyBinding(binding, IS_MAC)}</kbd>
                        ) : (
                          <span className="cheat-row__none">—</span>
                        )
                      ) : (
                        <span className="cheat-row__soon">Coming soon</span>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
