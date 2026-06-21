import { useUiStore } from "../../app/store";
import { useThreadForMessage } from "../../ipc/queries";
import { ConversationView } from "./ConversationView";
import { BulkActionPanel } from "./BulkActionPanel";
import "./reader.css";

function MessageReader({ messageId }: { messageId: number }) {
  const { data: threadId, isLoading } = useThreadForMessage(messageId);

  if (isLoading) {
    return <p className="loading-state">Loading…</p>;
  }
  if (threadId == null) {
    return <p className="empty-state">Select a conversation to read</p>;
  }
  return <ConversationView threadId={threadId} />;
}

export function ReaderPane() {
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectedMessageId = useUiStore((s) => s.selectedMessageId);
  const selectedRowIds = useUiStore((s) => s.selectedRowIds);

  let content;
  if (selectedRowIds.length >= 2) {
    content = <BulkActionPanel />;
  } else if (selectedThreadId != null) {
    content = <ConversationView threadId={selectedThreadId} />;
  } else if (selectedMessageId != null) {
    content = <MessageReader messageId={selectedMessageId} />;
  } else {
    content = <p className="empty-state">Select a conversation to read</p>;
  }

  return (
    <section className="pane reader-pane" aria-label="reader">
      {content}
    </section>
  );
}
