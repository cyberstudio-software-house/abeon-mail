import { useState } from "react";
import { useThreadMessages } from "../../ipc/queries";
import type { MessageHeader } from "../../ipc/bindings";
import { MessageBodyView } from "./MessageBodyView";

export function ConversationView({ threadId }: { threadId: number }) {
  const { data: messages, isLoading } = useThreadMessages(threadId);

  if (isLoading) return <p className="loading-state">Loading…</p>;
  if (!messages || messages.length === 0) return <p className="empty-state">No messages</p>;

  return (
    <div className="conversation" aria-label="conversation">
      {messages.map((m, i) => (
        <ConversationItem key={m.id} message={m} defaultExpanded={i === messages.length - 1} />
      ))}
    </div>
  );
}

function ConversationItem({ message, defaultExpanded }: { message: MessageHeader; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <article className={`conversation-item${expanded ? " conversation-item--open" : ""}`}>
      <header className="conversation-item__head" onClick={() => setExpanded((v) => !v)}>
        <span className="conversation-item__sender">{message.from_name || message.from_address}</span>
        <span className="conversation-item__subject">{message.subject}</span>
      </header>
      {expanded && <MessageBodyView messageId={message.id} />}
    </article>
  );
}
