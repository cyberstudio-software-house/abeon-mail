import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMessageBody, useMarkSeen } from "../../ipc/queries";
import { commands } from "../../ipc/bindings";
import { SafeHtmlFrame } from "./SafeHtmlFrame";

function RemoteContentBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="remote-content-banner" role="alert">
      <span>Remote content blocked</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title="Loading remote images is not yet supported in this version"
      >
        Load images
      </button>
    </div>
  );
}

export function MessageBodyView({ messageId }: { messageId: number }) {
  const { data: body, isLoading: bodyLoading } = useMessageBody(messageId);
  const markSeen = useMarkSeen();

  useEffect(() => {
    markSeen.mutate(messageId);
  }, [messageId]);

  const htmlSource = body?.text_html ?? null;

  const { data: sanitized, isLoading: sanitizeLoading } = useQuery({
    queryKey: ["sanitized", messageId],
    queryFn: () => commands.sanitizeMessageHtml(htmlSource!),
    enabled: htmlSource != null,
  });

  if (bodyLoading || (htmlSource != null && sanitizeLoading && sanitized == null)) {
    return <p className="loading-state">Loading…</p>;
  }

  if (htmlSource != null && sanitized != null) {
    return (
      <div className="message-body">
        {sanitized.blocked_remote_content && <RemoteContentBanner />}
        <SafeHtmlFrame html={sanitized.html} />
      </div>
    );
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
