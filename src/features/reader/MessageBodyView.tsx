import { useState, useEffect } from "react";
import { useRenderedMessage, useMessageBody, useMarkSeen } from "../../ipc/queries";
import { SafeHtmlFrame } from "./SafeHtmlFrame";

function RemoteContentBanner({ onLoad }: { onLoad: () => void }) {
  return (
    <div className="remote-content-banner" role="alert">
      <span>Remote content blocked</span>
      <button type="button" onClick={onLoad}>
        Load images
      </button>
    </div>
  );
}

export function MessageBodyView({ messageId, shouldMarkSeen }: { messageId: number; shouldMarkSeen: boolean }) {
  const [forceLoadRemote, setForceLoadRemote] = useState(false);
  const { data: rendered, isLoading: renderLoading } = useRenderedMessage(messageId, forceLoadRemote);
  const { data: body, isLoading: bodyLoading } = useMessageBody(messageId);
  const markSeen = useMarkSeen();

  useEffect(() => {
    setForceLoadRemote(false);
  }, [messageId]);

  useEffect(() => {
    if (shouldMarkSeen) {
      markSeen.mutate(messageId);
    }
  }, [messageId, shouldMarkSeen]);

  if (renderLoading && rendered == null) {
    return <p className="loading-state">Loading…</p>;
  }

  if (rendered?.html != null) {
    return (
      <div className="message-body">
        {rendered.blocked_remote_content && <RemoteContentBanner onLoad={() => setForceLoadRemote(true)} />}
        <SafeHtmlFrame html={rendered.html} />
      </div>
    );
  }

  if (bodyLoading) {
    return <p className="loading-state">Loading…</p>;
  }

  if (body?.text_plain != null) {
    return (
      <div className="message-body">
        <pre className="plain-text-body">{body.text_plain}</pre>
      </div>
    );
  }

  return <p className="empty-state">No content available</p>;
}
