import { useState, useEffect, useMemo } from "react";
import { useRenderedMessage, useMessageBody, useContentSecurityLevel } from "../../ipc/queries";
import { SafeHtmlFrame } from "./SafeHtmlFrame";
import { QuotedHistoryToggle } from "./QuotedHistoryToggle";
import { splitHtmlHistory, splitTextHistory } from "../../shared/quotedHistory";
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
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setForceLoadRemote(autoloadRemoteForLevel(level));
  }, [messageId, level]);

  useEffect(() => {
    setExpanded(false);
  }, [messageId]);

  const htmlSplit = useMemo(
    () => (rendered?.html != null ? splitHtmlHistory(rendered.html) : null),
    [rendered?.html]
  );
  const textSplit = useMemo(
    () => (body?.text_plain != null ? splitTextHistory(body.text_plain) : null),
    [body?.text_plain]
  );

  if (renderLoading && rendered == null) {
    return <p className="loading-state">Loading…</p>;
  }

  if (htmlSplit) {
    return (
      <div className="message-body">
        {rendered?.blocked_remote_content && <RemoteContentBanner onLoad={() => setForceLoadRemote(true)} />}
        <SafeHtmlFrame
          html={expanded ? htmlSplit.full : htmlSplit.collapsed}
          sandbox={sandboxForLevel(level)}
          interceptLinks={interceptLinksForLevel(level)}
          autoResize
        />
        {htmlSplit.hasHistory && (
          <QuotedHistoryToggle expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
        )}
      </div>
    );
  }

  if (bodyLoading) {
    return <p className="loading-state">Loading…</p>;
  }

  if (textSplit) {
    return (
      <div className="message-body">
        <pre className="plain-text-body">{expanded ? textSplit.full : textSplit.collapsed}</pre>
        {textSplit.hasHistory && (
          <QuotedHistoryToggle expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
        )}
      </div>
    );
  }

  return <p className="empty-state">No content available</p>;
}
