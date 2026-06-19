import { useState } from "react";
import { useShortcuts } from "../shortcuts/ShortcutsProvider";
import { ACTIONS, type ActionId, actionById } from "../shortcuts/registry";
import { conflictFor, prettyBinding, type Profile } from "../shortcuts/bindings";
import { useRecorder } from "../shortcuts/useRecorder";

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

const PROFILES: { value: Profile; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "vim", label: "Vim" },
];

function ShortcutRow({ id }: { id: ActionId }) {
  const { resolved, setBinding, resetBinding } = useShortcuts();
  const meta = actionById(id)!;
  const binding = resolved[id];
  const [pendingConflict, setPendingConflict] = useState<ActionId | null>(null);

  const recorder = useRecorder((captured) => {
    const conflict = conflictFor(captured, resolved, id);
    setPendingConflict(conflict);
    if (conflict) setBinding(conflict, null);
    setBinding(id, captured);
  });

  return (
    <div className={`shortcut-row${meta.enabled ? "" : " shortcut-row--disabled"}`}>
      <span className="shortcut-row__label">{meta.label}</span>
      <div className="shortcut-row__controls">
        {recorder.recording ? (
          <span className="shortcut-row__recording">
            {recorder.steps.length ? prettyBinding(recorder.steps.join(" "), IS_MAC) : "Press keys…"}
          </span>
        ) : binding ? (
          <kbd className="shortcut-row__kbd">{prettyBinding(binding, IS_MAC)}</kbd>
        ) : (
          <span className="shortcut-row__none">—</span>
        )}
        {meta.enabled && (
          <>
            <button
              type="button"
              className="shortcut-row__record"
              aria-label={`Record ${meta.label}`}
              onClick={() => {
                if (recorder.recording) {
                  recorder.cancel();
                } else {
                  setPendingConflict(null);
                  recorder.start();
                }
              }}
            >
              {recorder.recording ? "Cancel" : "Record"}
            </button>
            <button
              type="button"
              className="shortcut-row__reset"
              aria-label={`Reset ${meta.label}`}
              onClick={() => {
                setPendingConflict(null);
                resetBinding(id);
              }}
            >
              Reset
            </button>
          </>
        )}
      </div>
      {pendingConflict && (
        <div className="shortcut-row__conflict" role="status">
          ⚠ Reassigned from {actionById(pendingConflict)?.label}
        </div>
      )}
    </div>
  );
}

export function ShortcutsSection() {
  const { profile, setProfile } = useShortcuts();

  return (
    <div className="shortcuts-section">
      <p className="shortcuts-section__intro">
        Choose a profile and customize key bindings. New bindings override conflicts.
      </p>
      <div className="appearance-field__label">Profile</div>
      <div className="theme-cards">
        {PROFILES.map((p) => (
          <button
            key={p.value}
            type="button"
            aria-pressed={profile === p.value}
            className={`theme-card${profile === p.value ? " theme-card--active" : ""}`}
            onClick={() => setProfile(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="appearance-field__label">Shortcuts</div>
      <div className="shortcut-list">
        {ACTIONS.map((a) => (
          <ShortcutRow key={a.id} id={a.id} />
        ))}
      </div>
    </div>
  );
}
