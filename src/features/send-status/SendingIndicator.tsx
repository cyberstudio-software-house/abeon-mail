import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { useUiStore } from "../../app/store";
import "./SendingIndicator.css";

const SENT_VISIBLE_MS = 2500;

export function SendingIndicator() {
  const sendingCount = useUiStore((s) => s.sendingCount);
  const lastSentAt = useUiStore((s) => s.lastSentAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (sendingCount > 0 || lastSentAt == null) return;
    setNow(Date.now());
    const remaining = SENT_VISIBLE_MS - (Date.now() - lastSentAt);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [sendingCount, lastSentAt]);

  if (sendingCount > 0) {
    const label = sendingCount > 1 ? `Sending (${sendingCount})…` : "Sending…";
    return (
      <div className="sending-indicator" role="status" aria-live="polite">
        <Loader2 className="sending-indicator__spinner" size={16} aria-hidden="true" />
        <span>{label}</span>
      </div>
    );
  }

  const showSent = lastSentAt != null && now - lastSentAt < SENT_VISIBLE_MS;
  if (showSent) {
    return (
      <div className="sending-indicator sending-indicator--sent" role="status" aria-live="polite">
        <Check size={16} aria-hidden="true" />
        <span>Sent</span>
      </div>
    );
  }

  return null;
}
