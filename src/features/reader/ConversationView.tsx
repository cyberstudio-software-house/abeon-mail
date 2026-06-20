import { useEffect, useRef, useState } from "react";
import { Reply, ReplyAll, Forward, Star, Archive, Clock, Trash2, MoreHorizontal, SendHorizontal, Tag, Mail, MailOpen } from "lucide-react";
import { useThreadMessages, useStartReply, useSetFlag, useLabelsForMessages, useSetSeen } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { Avatar } from "../../shared/appearance/Avatar";
import { MessageBodyView } from "./MessageBodyView";
import { AttachmentsBar } from "./AttachmentsBar";
import { LabelChips } from "../labels/LabelChips";
import { formatMessageTime } from "../../shared/datetime/datetime";
import { seenIdsForBulk } from "./seen";
import "./reader.css";

export function ConversationView({ threadId }: { threadId: number }) {
  const { data: messages, isLoading } = useThreadMessages(threadId);
  const openComposer = useUiStore((s) => s.openComposer);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
  const openSnoozePicker = useUiStore((s) => s.openSnoozePicker);
  const timeFormat = useUiStore((s) => s.timeFormat);
  const markReadMode = useUiStore((s) => s.markReadMode);
  const markReadDelaySeconds = useUiStore((s) => s.markReadDelaySeconds);
  const generalHydrated = useUiStore((s) => s.generalHydrated);
  const setSeen = useSetSeen();
  const startReplyMutation = useStartReply();
  const setFlag = useSetFlag();
  const setReplyTargetId = useUiStore((s) => s.setReplyTargetId);
  const lastId = messages && messages.length > 0 ? messages[messages.length - 1].id : null;
  const labelPairs = useLabelsForMessages(lastId ? [lastId] : []);
  const lastLabels = (labelPairs.data ?? []).map(([, label]) => label);

  const [activeId, setActiveId] = useState<number | null>(null);
  useEffect(() => {
    setActiveId(null);
  }, [threadId]);

  useEffect(() => {
    setReplyTargetId(lastId);
    return () => setReplyTargetId(null);
  }, [lastId, setReplyTargetId]);

  const autoMarkDoneRef = useRef(false);
  const markTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    autoMarkDoneRef.current = false;
    if (markTimerRef.current) {
      clearTimeout(markTimerRef.current);
      markTimerRef.current = null;
    }
  }, [threadId]);

  useEffect(() => {
    return () => {
      if (markTimerRef.current) clearTimeout(markTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (autoMarkDoneRef.current) return;
    if (!generalHydrated) return;
    if (isLoading || messages == null) return;
    autoMarkDoneRef.current = true;
    if (markReadMode === "never") return;
    const ids = seenIdsForBulk(messages, true);
    if (ids.length === 0) return;
    if (markReadMode === "immediate") {
      setSeen.mutate({ ids, value: true });
    } else {
      const epoch = useUiStore.getState().markUnreadEpoch;
      markTimerRef.current = setTimeout(() => {
        if (useUiStore.getState().markUnreadEpoch !== epoch) return;
        setSeen.mutate({ ids, value: true });
      }, markReadDelaySeconds * 1000);
    }
  }, [threadId, generalHydrated, isLoading, messages, markReadMode, markReadDelaySeconds, setSeen]);

  if (isLoading) return <p className="loading-state">Loading…</p>;
  if (!messages || messages.length === 0) return <p className="empty-state">No messages</p>;

  const last = messages[messages.length - 1];
  const senderName = last.from_name || last.from_address;
  const anyUnread = messages.some((m) => !m.seen);
  const effectiveActiveId = activeId ?? lastId;

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
        <button
          type="button"
          className="reader__icon"
          aria-label="Snooze"
          onClick={() => openSnoozePicker(messages.map((m) => m.id))}
        >
          <Clock size={18} />
        </button>
        <button
          type="button"
          className="reader__icon"
          aria-label={anyUnread ? "Mark as read" : "Mark as unread"}
          onClick={() => setSeen.mutate({ ids: seenIdsForBulk(messages, anyUnread), value: anyUnread })}
        >
          {anyUnread ? <MailOpen size={18} /> : <Mail size={18} />}
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
        <button
          type="button"
          className="reader__icon"
          aria-label="Label"
          onClick={() => openLabelPicker([last.id])}
        >
          <Tag size={18} />
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
          {lastLabels.length > 0 && (
            <div className="reader__labels">
              <LabelChips labels={lastLabels} />
            </div>
          )}

          <div className="reader__thread">
            {messages.map((m) => {
              const name = m.from_name || m.from_address;
              const time = formatMessageTime(m.date, timeFormat);
              if (m.id !== effectiveActiveId) {
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="reader__collapsed"
                    aria-label={`Expand message from ${name}`}
                    onClick={() => setActiveId(m.id)}
                  >
                    <Avatar seed={m.from_address} label={name} size={34} />
                    <div className="reader__collapsed-info">
                      <span className="reader__collapsed-name">{name}</span>
                      {m.snippet && <span className="reader__collapsed-snippet">{m.snippet}</span>}
                    </div>
                    <span className="reader__sender-time">{time}</span>
                  </button>
                );
              }
              return (
                <div key={m.id} className="reader__active">
                  <div className="reader__sender">
                    <Avatar seed={m.from_address} label={name} size={46} />
                    <div className="reader__sender-info">
                      <div className="reader__sender-name">{name}</div>
                    </div>
                    <span className="reader__sender-time">{time}</span>
                  </div>
                  <MessageBodyView messageId={m.id} />
                  <AttachmentsBar messageId={m.id} />
                </div>
              );
            })}
          </div>
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
