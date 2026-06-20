import { useAppUpdate } from "./useAppUpdate";

export function UpdatesPanel() {
  const u = useAppUpdate();

  return (
    <div className="updates-panel">
      <div className="updates-panel__version">AbeonMail {u.version}</div>
      <button
        type="button"
        className="updates-panel__check settings-btn settings-btn--sm"
        onClick={u.checkForUpdate}
        disabled={u.status === "checking" || u.status === "downloading"}
      >
        Check for updates
      </button>
      {u.status === "checking" && <span className="updates-panel__status">Checking…</span>}
      {u.status === "uptodate" && <span className="updates-panel__status">You're up to date.</span>}
      {u.status === "error" && (
        <span className="updates-panel__status">Couldn't check for updates.</span>
      )}
      {u.status === "available" && (
        <div className="updates-panel__available">
          <span className="updates-panel__status">Version {u.newVersion} is available.</span>
          <button
            type="button"
            className="settings-btn settings-btn--sm settings-btn--primary"
            onClick={u.installUpdate}
          >
            Download &amp; install
          </button>
        </div>
      )}
      {u.status === "downloading" && <span className="updates-panel__status">Downloading…</span>}
    </div>
  );
}
