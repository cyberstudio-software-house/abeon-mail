import { useState, useEffect } from "react";
import { useRenderedMessage, useMessageBody, useContentSecurityLevel } from "../../ipc/queries";
import { SafeHtmlFrame } from "./SafeHtmlFrame";
import {
  sandboxForLevel,
  interceptLinksForLevel,
  autoloadRemoteForLevel,
  DEFAULT_CONTENT_SECURITY_LEVEL,
} from "../../shared/contentSecurity";

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

export function MessageBodyView({ messageId }: { messageId: number }) {
  const { data: level = DEFAULT_CONTENT_SECURITY_LEVEL } = useContentSecurityLevel();
  const [forceLoadRemote, setForceLoadRemote] = useState(autoloadRemoteForLevel(level));
  const { data: rendered, isLoading: renderLoading } = useRenderedMessage(messageId, forceLoadRemote);
  const { data: body, isLoading: bodyLoading } = useMessageBody(messageId);

  useEffect(() => {
    setForceLoadRemote(autoloadRemoteForLevel(level));
  }, [messageId, level]);

  if (renderLoading && rendered == null) {
    return <p className="loading-state">Loading…</p>;
  }

  if (rendered?.html != null) {
    return (
      <div className="message-body">
        {rendered.blocked_remote_content && <RemoteContentBanner onLoad={() => setForceLoadRemote(true)} />}
        <SafeHtmlFrame
          html={rendered.html}
          sandbox={sandboxForLevel(level)}
          interceptLinks={interceptLinksForLevel(level)}
          autoResize
        />
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
