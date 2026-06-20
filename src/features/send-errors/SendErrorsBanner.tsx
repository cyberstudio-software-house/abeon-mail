import { useSendErrors, useRetrySend, useDismissSendError } from "../../ipc/queries";
import "./SendErrorsBanner.css";

export function SendErrorsBanner() {
  const { data: errors = [] } = useSendErrors();
  const retry = useRetrySend();
  const dismiss = useDismissSendError();

  if (errors.length === 0) return null;

  return (
    <div className="send-errors" role="alert">
      <div className="send-errors__header">
        <span className="send-errors__icon" aria-hidden="true">⚠</span>
        <span className="send-errors__title">
          {errors.length === 1
            ? "1 message failed to send"
            : `${errors.length} messages failed to send`}
        </span>
      </div>
      <ul className="send-errors__list">
        {errors.map((entry) => {
          const label = entry.subject || entry.recipient || "(no subject)";
          return (
            <li key={entry.id} className="send-errors__item">
              <div className="send-errors__text">
                <span className="send-errors__subject">{label}</span>
                <span className="send-errors__detail">{entry.error}</span>
              </div>
              <div className="send-errors__actions">
                <button
                  type="button"
                  className="send-errors__btn"
                  onClick={() => retry.mutate(entry.id)}
                  aria-label={`Retry sending ${label}`}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="send-errors__btn send-errors__btn--ghost"
                  onClick={() => dismiss.mutate(entry.id)}
                  aria-label={`Dismiss send error for ${label}`}
                >
                  Dismiss
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
