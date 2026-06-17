import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUiStore } from "../../app/store";
import { useMessageBody } from "../../ipc/queries";
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

export function ReaderPane() {
  const selectedMessageId = useUiStore((s) => s.selectedMessageId);
  const { data: body, isLoading: bodyLoading } = useMessageBody(selectedMessageId);

  const htmlSource = body?.text_html ?? null;

  const { data: sanitized, isLoading: sanitizeLoading } = useQuery({
    queryKey: ["sanitized", selectedMessageId],
    queryFn: () => commands.sanitizeMessageHtml(htmlSource!),
    enabled: selectedMessageId != null && htmlSource != null,
  });

  if (selectedMessageId == null) {
    return (
      <section className="pane reader-pane" aria-label="reader">
        <p className="empty-state">Select a message to read</p>
      </section>
    );
  }

  if (bodyLoading || (htmlSource != null && sanitizeLoading && sanitized == null)) {
    return (
      <section className="pane reader-pane" aria-label="reader">
        <p className="loading-state">Loading…</p>
      </section>
    );
  }

  if (htmlSource != null && sanitized != null) {
    return (
      <section className="pane reader-pane" aria-label="reader">
        {sanitized.blocked_remote_content && <RemoteContentBanner />}
        <SafeHtmlFrame html={sanitized.html} />
      </section>
    );
  }

  if (body?.text_plain != null) {
    return (
      <section className="pane reader-pane" aria-label="reader">
        <pre className="plain-text-body">{body.text_plain}</pre>
      </section>
    );
  }

  return (
    <section className="pane reader-pane" aria-label="reader">
      <p className="empty-state">No content available</p>
    </section>
  );
}
