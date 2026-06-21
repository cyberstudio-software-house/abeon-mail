import { useEffect, useRef, useState } from "react";
import { Reply, ReplyAll, Forward, Star, Archive, Clock, Trash2, MoreHorizontal, SendHorizontal, Tag, Mail, MailOpen } from "lucide-react";
import { useThreadMessages, useStartReply, useSetFlag, useLabelsForMessages, useSetSeen, useArchive, useDelete, useAccounts, useMessageRecipients } from "../../ipc/queries";
import type { MessageHeader } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { Avatar } from "../../shared/appearance/Avatar";
import { MessageBodyView } from "./MessageBodyView";
import { AttachmentsBar } from "./AttachmentsBar";
import { LabelChips } from "../labels/LabelChips";
import { formatMessageTime } from "../../shared/datetime/datetime";
import { seenIdsForBulk } from "./seen";
import "./reader.css";

function ActiveMessage({ message, accountEmail }: { message: MessageHeader; accountEmail: string | null }) {
  const timeFormat = useUiStore((s) => s.timeFormat);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const recipients = useMessageRecipients(detailsOpen ? message.id : null);

  useEffect(() => {
    setDetailsOpen(false);
  }, [message.id]);

  const name = message.from_name || message.from_address;
  const time = formatMessageTime(message.date, timeFormat);
  const to = recipients.data?.to ?? [];
  const cc = recipients.data?.cc ?? [];

  return (
    <div className="reader__active">
      <div className="reader__sender">
        <Avatar seed={message.from_address} label={name} size={46} />
        <button
          type="button"
          className="reader__sender-info"
          aria-expanded={detailsOpen}
          aria-label={`Sender details for ${name}`}
          onClick={() => setDetailsOpen((v) => !v)}
        >
          <span className="reader__sender-name">{name}</span>
          {accountEmail && <span className="reader__sender-sub">to {accountEmail}</span>}
        </button>
        <span className="reader__sender-time">{time}</span>
      </div>

      {detailsOpen && (
        <dl className="reader__details">
          <div className="reader__details-row">
            <dt>From</dt>
            <dd>{message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address}</dd>
          </div>
          {accountEmail && (
            <div className="reader__details-row">
              <dt>Account</dt>
              <dd>{accountEmail}</dd>
            </div>
          )}
          {to.length > 0 && (
            <div className="reader__details-row">
              <dt>To</dt>
              <dd>{to.join(", ")}</dd>
            </div>
          )}
          {cc.length > 0 && (
            <div className="reader__details-row">
              <dt>Cc</dt>
              <dd>{cc.join(", ")}</dd>
            </div>
          )}
        </dl>
      )}

      <MessageBodyView messageId={message.id} />
      <AttachmentsBar messageId={message.id} />
    </div>
  );
}

export function ConversationView({ threadId }: { threadId: number }) {
  const { data: messages, isLoading } = useThreadMessages(threadId);
  const { data: accounts = [] } = useAccounts();
  const openComposer = useUiStore((s) => s.openComposer);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
  const openSnoozePicker = useUiStore((s) => s.openSnoozePicker);
  const openFolderPicker = useUiStore((s) => s.openFolderPicker);
  const timeFormat = useUiStore((s) => s.timeFormat);
  const threadOrder = useUiStore((s) => s.threadOrder);
  const markReadMode = useUiStore((s) => s.markReadMode);
  const markReadDelaySeconds = useUiStore((s) => s.markReadDelaySeconds);
  const generalHydrated = useUiStore((s) => s.generalHydrated);
  const setSeen = useSetSeen();
  const startReplyMutation = useStartReply();
  const setFlag = useSetFlag();
  const archive = useArchive();
  const del = useDelete();
  const showUndoToast = useUiStore((s) => s.showUndoToast);
  const setSelectedThreadId = useUiStore((s) => s.setSelectedThreadId);
  const setReplyTargetId = useUiStore((s) => s.setReplyTargetId);
  const lastId = messages && messages.length > 0 ? messages[messages.length - 1].id : null;
  const labelPairs = useLabelsForMessages(lastId ? [lastId] : []);
  const lastLabels = (labelPairs.data ?? []).map(([, label]) => label);

  const [activeId, setActiveId] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveId(null);
  }, [threadId]);

  useEffect(() => {
    setReplyTargetId(lastId);
    return () => setReplyTargetId(null);
  }, [lastId, setReplyTargetId]);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

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
  const orderedMessages = threadOrder === "descending" ? [...messages].reverse() : messages;
  const accountEmail = accounts.find((a) => a.id === last.account_id)?.email ?? null;

  function moveThread(kind: "archive" | "delete") {
    const ids = (messages ?? []).map((m) => m.id);
    if (ids.length === 0) return;
    if (kind === "archive") archive.mutate({ messageIds: ids });
    else del.mutate({ messageIds: ids });
    showUndoToast(kind, ids);
    setSelectedThreadId(null);
  }

  async function handleReply(mode: "reply" | "reply_all" | "forward") {
    const prefill = await startReplyMutation.mutateAsync({ messageId: last.id, mode });
    openComposer(null, prefill);
  }

  const moreActions: { label: string; onClick: () => void }[] = [
    {
      label: "Move to folder…",
      onClick: () => openFolderPicker(messages.map((m) => m.id), last.account_id),
    },
    {
      label: last.flagged ? "Remove importance" : "Mark as important",
      onClick: () => setFlag.mutate({ messageId: last.id, flag: "flagged", value: !last.flagged }),
    },
    {
      label: "Mark as unread",
      onClick: () => setSeen.mutate({ ids: seenIdsForBulk(messages, false), value: false }),
    },
  ];

  return (
    <div className="reader">
      <div className="reader__toolbar">
        <button type="button" className="reader__icon" aria-label="Archive" title="Archive" onClick={() => moveThread("archive")}>
          <Archive size={18} />
        </button>
        <button
          type="button"
          className="reader__icon"
          aria-label="Snooze"
          title="Snooze"
          onClick={() => openSnoozePicker(messages.map((m) => m.id))}
        >
          <Clock size={18} />
        </button>
        <button
          type="button"
          className="reader__icon"
          aria-label={anyUnread ? "Mark as read" : "Mark as unread"}
          title={anyUnread ? "Mark as read" : "Mark as unread"}
          onClick={() => setSeen.mutate({ ids: seenIdsForBulk(messages, anyUnread), value: anyUnread })}
        >
          {anyUnread ? <MailOpen size={18} /> : <Mail size={18} />}
        </button>
        <button type="button" className="reader__icon" aria-label="Delete" title="Delete" onClick={() => moveThread("delete")}>
          <Trash2 size={18} />
        </button>
        <div className="reader__divider" />
        <button type="button" className="reader__icon" aria-label="Reply" title="Reply" onClick={() => handleReply("reply")}>
          <Reply size={18} />
        </button>
        <button type="button" className="reader__icon" aria-label="Reply all" title="Reply all" onClick={() => handleReply("reply_all")}>
          <ReplyAll size={18} />
        </button>
        <button type="button" className="reader__icon" aria-label="Forward" title="Forward" onClick={() => handleReply("forward")}>
          <Forward size={18} />
        </button>
        <button
          type="button"
          className="reader__icon"
          aria-label="Label"
          title="Label"
          onClick={() => openLabelPicker([last.id])}
        >
          <Tag size={18} />
        </button>
        <div className="reader__spacer" />
        <div className="reader__more" ref={menuRef}>
          <button
            type="button"
            className="reader__icon"
            aria-label="More actions"
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal size={18} />
          </button>
          {menuOpen && (
            <div className="reader__menu" role="menu">
              {moreActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  className="reader__menu-item"
                  onClick={() => {
                    action.onClick();
                    setMenuOpen(false);
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="reader__body">
        <div className="reader__inner">
          <div className="reader__subject-row">
            <h2 className="reader__subject">{last.subject}</h2>
            <button
              type="button"
              className={`reader__star${last.flagged ? " reader__star--on" : ""}`}
              aria-label={last.flagged ? "Remove importance" : "Mark as important"}
              title={last.flagged ? "Remove importance" : "Mark as important"}
              aria-pressed={last.flagged}
              onClick={() => setFlag.mutate({ messageId: last.id, flag: "flagged", value: !last.flagged })}
            >
              <Star size={20} fill={last.flagged ? "currentColor" : "none"} />
            </button>
          </div>
          {lastLabels.length > 0 && (
            <div className="reader__labels">
              <LabelChips labels={lastLabels} />
            </div>
          )}

          <div className="reader__thread">
            {orderedMessages.map((m) => {
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
                    {m.flagged && <Star className="reader__collapsed-flag" size={14} fill="currentColor" />}
                    <span className="reader__sender-time">{time}</span>
                  </button>
                );
              }
              return <ActiveMessage key={m.id} message={m} accountEmail={accountEmail} />;
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
