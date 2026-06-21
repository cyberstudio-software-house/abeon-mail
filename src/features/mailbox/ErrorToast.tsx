import { useUiStore } from "../../app/store";
import "./ErrorToast.css";

export function ErrorToast() {
  const message = useUiStore((s) => s.errorToast);
  const clearErrorToast = useUiStore((s) => s.clearErrorToast);
  if (!message) return null;
  return (
    <div className="error-toast" role="alert">
      <span className="error-toast__text">{message}</span>
      <button type="button" className="error-toast__close" aria-label="Dismiss" onClick={clearErrorToast}>
        ✕
      </button>
    </div>
  );
}
