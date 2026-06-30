import { useAppUpdate } from "./useAppUpdate";
import { commands } from "../../ipc/bindings";
import "./UpdateAvailableBanner.css";

const RELEASES_URL = "https://github.com/cyberstudio-software-house/abeon-mail/releases/latest";

export function UpdateAvailableBanner() {
  const u = useAppUpdate({ checkOnMount: true });

  const failed = u.status === "error" && u.error !== "";
  if (u.status !== "available" && u.status !== "downloading" && !failed) return null;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner__text">
        <span className="update-banner__title">{failed ? "Update failed" : "Update available"}</span>
        <span className="update-banner__detail">
          {failed
            ? "Couldn't install the update automatically. Download the latest version manually."
            : u.status === "downloading"
              ? "Downloading and installing…"
              : `Version ${u.newVersion} is ready to install.`}
        </span>
      </div>
      {u.status === "available" && (
        <button type="button" className="update-banner__btn" onClick={u.installUpdate}>
          Restart &amp; update
        </button>
      )}
      {failed && (
        <button
          type="button"
          className="update-banner__btn"
          onClick={() => void commands.openExternalUrl(RELEASES_URL)}
        >
          Download
        </button>
      )}
    </div>
  );
}
