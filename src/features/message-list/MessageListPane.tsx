import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMessages } from "../../ipc/queries";
import { useUiStore, type Density } from "../../app/store";
import type { MessageHeader } from "../../ipc/bindings";
import "./MessageListPane.css";

const ROW_HEIGHT: Record<Density, number> = {
  comfortable: 72,
  cozy: 60,
  compact: 48,
  dense: 36,
};

function formatDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function MessageRow({
  message,
  isSelected,
  rowHeight,
  onSelect,
}: {
  message: MessageHeader;
  isSelected: boolean;
  rowHeight: number;
  onSelect: (id: number) => void;
}) {
  const sender = message.from_name || message.from_address;
  const isUnread = !message.seen;

  return (
    <div
      className={`message-row${isUnread ? " message-row--unread" : ""}${isSelected ? " message-row--selected" : ""}`}
      style={{ height: rowHeight }}
      data-message-id={message.id}
      onClick={() => onSelect(message.id)}
      role="option"
      aria-selected={isSelected}
    >
      <div className="message-row__indicators">
        {isUnread && <span className="message-row__unread-dot" aria-label="unread" />}
      </div>
      <div className="message-row__content">
        <div className="message-row__header">
          <span className={`message-row__sender${isUnread ? " message-row__sender--bold" : ""}`}>{sender}</span>
          <span className="message-row__date">{formatDate(message.date)}</span>
        </div>
        <div className="message-row__meta">
          <span className="message-row__subject">{message.subject}</span>
          <div className="message-row__badges">
            {message.flagged && <span className="message-row__flag" aria-label="flagged">⚑</span>}
            {message.has_attachments && <span className="message-row__attachment" aria-label="has attachments">📎</span>}
          </div>
        </div>
        <span className="message-row__snippet">{message.snippet}</span>
      </div>
    </div>
  );
}

function SkeletonRow({ height }: { height: number }) {
  return (
    <div className="skeleton-row" style={{ height }}>
      <div className="skeleton-row__sender" />
      <div className="skeleton-row__subject" />
    </div>
  );
}

export function MessageListPane() {
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const selectedMessageId = useUiStore((s) => s.selectedMessageId);
  const density = useUiStore((s) => s.density);
  const setSelectedMessageId = useUiStore((s) => s.setSelectedMessageId);

  const { data: messages, isLoading } = useMessages(selectedFolderId);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHT[density] ?? ROW_HEIGHT.comfortable;

  const virtualizer = useVirtualizer({
    count: messages?.length ?? 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section className="pane message-list-pane" aria-label="message-list">
      {selectedFolderId == null && (
        <div className="message-list__empty">Select a folder</div>
      )}

      {selectedFolderId != null && isLoading && (
        <div className="message-list__scroll" style={{ height: "100%" }}>
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonRow key={i} height={rowHeight} />
          ))}
        </div>
      )}

      {selectedFolderId != null && !isLoading && messages?.length === 0 && (
        <div className="message-list__empty">No messages</div>
      )}

      {selectedFolderId != null && !isLoading && messages && messages.length > 0 && (
        <div
          ref={scrollContainerRef}
          className="message-list__scroll"
          style={{ height: "100%", overflow: "auto" }}
          role="listbox"
          aria-label="messages"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((virtualItem) => {
              const message = messages[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: "absolute",
                    top: virtualItem.start,
                    left: 0,
                    right: 0,
                    height: virtualItem.size,
                  }}
                >
                  <MessageRow
                    message={message}
                    isSelected={selectedMessageId === message.id}
                    rowHeight={rowHeight}
                    onSelect={setSelectedMessageId}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
