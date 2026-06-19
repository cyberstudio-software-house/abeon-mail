import { useEffect } from "react";
import { Reply, ReplyAll, Forward, Star, Archive, Clock, Trash2, MoreHorizontal, SendHorizontal } from "lucide-react";
import { useThreadMessages, useStartReply, useSetFlag } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { Avatar } from "../../shared/appearance/Avatar";
import { MessageBodyView } from "./MessageBodyView";
import "./reader.css";

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function ConversationView({ threadId }: { threadId: number }) {
  const { data: messages, isLoading } = useThreadMessages(threadId);
  const openComposer = useUiStore((s) => s.openComposer);
  const startReplyMutation = useStartReply();
  const setFlag = useSetFlag();
  const setReplyTargetId = useUiStore((s) => s.setReplyTargetId);
  const lastId = messages && messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    setReplyTargetId(lastId);
    return () => setReplyTargetId(null);
  }, [lastId, setReplyTargetId]);

  if (isLoading) return <p className="loading-state">Loading…</p>;
  if (!messages || messages.length === 0) return <p className="empty-state">No messages</p>;

  const last = messages[messages.length - 1];
  const senderName = last.from_name || last.from_address;

  async function handleReply(mode: "reply" | "reply_all" | "forward") {
    const prefill = await startReplyMutation.mutateAsync({ messageId: last.id, mode });
    openComposer(null, prefill);
  }

  return (
    <div className="reader">
      <div className="reader__toolbar">
        <button type="button" className="reader__icon" aria-label="Archive" aria-disabled="true">
          <Archive size={18} />
        </button>
        <button type="button" className="reader__icon" aria-label="Snooze" aria-disabled="true">
          <Clock size={18} />
        </button>
        <button type="button" className="reader__icon" aria-label="Delete" aria-disabled="true">
          <Trash2 size={18} />
        </button>
        <div className="reader__divider" />
        <button type="button" className="reader__icon" aria-label="Reply" onClick={() => handleReply("reply")}>
          <Reply size={18} />
        </button>
        <button type="button" className="reader__icon" aria-label="Reply all" onClick={() => handleReply("reply_all")}>
          <ReplyAll size={18} />
        </button>
        <button type="button" className="reader__icon" aria-label="Forward" onClick={() => handleReply("forward")}>
          <Forward size={18} />
        </button>
        <div className="reader__spacer" />
        <button type="button" className="reader__icon" aria-label="More" aria-disabled="true">
          <MoreHorizontal size={18} />
        </button>
      </div>

      <div className="reader__body">
        <div className="reader__inner">
          <div className="reader__subject-row">
            <h2 className="reader__subject">{last.subject}</h2>
            <button
              type="button"
              className={`reader__star${last.flagged ? " reader__star--on" : ""}`}
              aria-label="Flag"
              onClick={() => setFlag.mutate({ messageId: last.id, flag: "flagged", value: !last.flagged })}
            >
              <Star size={20} />
            </button>
          </div>

          {messages.map((m) => (
            <div key={m.id} className="reader__message">
              <div className="reader__sender">
                <Avatar seed={m.from_address} label={m.from_name || m.from_address} size={46} />
                <div className="reader__sender-info">
                  <div className="reader__sender-name">{m.from_name || m.from_address}</div>
                </div>
                <span className="reader__sender-time">{formatTime(m.date)}</span>
              </div>
              <MessageBodyView messageId={m.id} shouldMarkSeen={m.id === last.id} />
            </div>
          ))}
        </div>
      </div>

      <div className="reader__reply">
        <button
          type="button"
          className="reader__reply-trigger"
          aria-label={`Reply to ${senderName}…`}
          onClick={() => handleReply("reply")}
        >
          Reply to {senderName}…
        </button>
        <button
          type="button"
          className="reader__send"
          aria-label="Send"
          onClick={() => handleReply("reply")}
        >
          <SendHorizontal size={16} />
          Send
        </button>
      </div>
    </div>
  );
}
