import { useUiStore } from "../../app/store";
import { ConversationView } from "./ConversationView";
import "./reader.css";

export function ReaderPane() {
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);

  if (selectedThreadId == null) {
    return (
      <section className="pane reader-pane" aria-label="reader">
        <p className="empty-state">Select a conversation to read</p>
      </section>
    );
  }

  return (
    <section className="pane reader-pane" aria-label="reader">
      <ConversationView threadId={selectedThreadId} />
    </section>
  );
}
