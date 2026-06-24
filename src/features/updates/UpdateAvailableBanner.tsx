import { useAppUpdate } from "./useAppUpdate";
import "./UpdateAvailableBanner.css";

export function UpdateAvailableBanner() {
  const u = useAppUpdate({ checkOnMount: true });

  if (u.status !== "available" && u.status !== "downloading") return null;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner__text">
        <span className="update-banner__title">Update available</span>
        <span className="update-banner__detail">
          {u.status === "downloading"
            ? "Downloading and installing…"
            : `Version ${u.newVersion} is ready to install.`}
        </span>
      </div>
      {u.status === "available" && (
        <button type="button" className="update-banner__btn" onClick={u.installUpdate}>
          Restart &amp; update
        </button>
      )}
    </div>
  );
}
