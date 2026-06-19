import { useEffect } from "react";
import { Command } from "cmdk";
import { useShortcuts } from "./ShortcutsProvider";
import { ACTIONS, type ActionId } from "./registry";
import { prettyBinding } from "./bindings";
import { useUiStore } from "../../app/store";
import { useFolders } from "../../ipc/queries";
import "./CommandPalette.css";

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const closePalette = useUiStore((s) => s.closePalette);
  const openComposer = useUiStore((s) => s.openComposer);
  const openSettings = useUiStore((s) => s.openSettings);
  const setSelectedSmartFolder = useUiStore((s) => s.setSelectedSmartFolder);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);
  const toggleCheatSheet = useUiStore((s) => s.toggleCheatSheet);
  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const { resolved } = useShortcuts();
  const { data: folders } = useFolders(selectedAccountId);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePalette();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closePalette]);

  if (!open) return null;

  const paletteActions: Partial<Record<ActionId, () => void>> = {
    compose: () => openComposer(null),
    "open-settings": () => openSettings(),
    "go-inbox": () => setSelectedSmartFolder("all_inboxes"),
    "go-starred": () => setSelectedSmartFolder("flagged"),
    "cheat-sheet": () => toggleCheatSheet(),
    search: () => requestAnimationFrame(() => useUiStore.getState().focusSearch?.()),
  };

  function run(fn: () => void) {
    closePalette();
    fn();
  }

  const visibleActions = ACTIONS.filter((a) => a.enabled && paletteActions[a.id]);

  return (
    <div className="palette-overlay" onClick={closePalette} role="presentation">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <Command label="Command palette" loop>
          <Command.Input autoFocus placeholder="Type a command or search…" />
          <Command.List>
            <Command.Empty>No results.</Command.Empty>
            <Command.Group heading="Actions">
              {visibleActions.map((a) => {
                const binding = resolved[a.id];
                return (
                  <Command.Item key={a.id} value={a.label} onSelect={() => run(paletteActions[a.id]!)}>
                    <span>{a.label}</span>
                    {binding && <kbd className="palette__kbd">{prettyBinding(binding, IS_MAC)}</kbd>}
                  </Command.Item>
                );
              })}
            </Command.Group>
            <Command.Group heading="Smart folders">
              <Command.Item value="All Inboxes" onSelect={() => run(() => setSelectedSmartFolder("all_inboxes"))}>
                All Inboxes
              </Command.Item>
              <Command.Item value="Unread" onSelect={() => run(() => setSelectedSmartFolder("unread"))}>
                Unread
              </Command.Item>
              <Command.Item value="Flagged" onSelect={() => run(() => setSelectedSmartFolder("flagged"))}>
                Flagged
              </Command.Item>
            </Command.Group>
            {folders && folders.length > 0 && (
              <Command.Group heading="Folders">
                {folders.map((f) => (
                  <Command.Item
                    key={f.id}
                    value={`folder ${f.name}`}
                    onSelect={() => run(() => setSelectedFolderId(f.id))}
                  >
                    {f.name}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
