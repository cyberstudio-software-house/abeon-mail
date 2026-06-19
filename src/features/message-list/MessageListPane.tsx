import { useRef, useMemo, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PencilLine, ChevronDown } from "lucide-react";
import { useThreads, useSmartFolder, useSearch } from "../../ipc/queries";
import { useDebouncedValue } from "../../shared/hooks/useDebouncedValue";
import { useUiStore, type Density } from "../../app/store";
import type { ThreadSummary, SmartMessageRow } from "../../ipc/bindings";
import { Avatar } from "../../shared/appearance/Avatar";
import { groupIntoEntries, type ListEntry } from "./grouping";
import { extractTerms, Highlight } from "./highlight";
import "./MessageListPane.css";

const ROW_HEIGHT: Record<Density, number> = {
  comfortable: 72,
  compact: 48,
  dense: 36,
};

const HEADER_HEIGHT = 28;

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

function ThreadRow({
  thread,
  isSelected,
  rowHeight,
  showAvatars,
  showSnippet,
  onSelect,
}: {
  thread: ThreadSummary;
  isSelected: boolean;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  onSelect: (id: number) => void;
}) {
  const isUnread = thread.unread_count > 0;

  return (
    <div
      className={`message-row${isUnread ? " message-row--unread" : ""}${isSelected ? " message-row--selected" : ""}`}
      style={{ height: rowHeight }}
      data-thread-id={thread.thread_id}
      onClick={() => onSelect(thread.thread_id)}
      role="option"
      aria-selected={isSelected}
    >
      <div className="message-row__indicators">
        {isUnread && <span className="message-row__unread-dot" aria-label="unread" />}
      </div>
      {showAvatars && (
        <Avatar
          seed={thread.participants[0] ?? thread.subject}
          label={thread.participants[0] ?? "?"}
        />
      )}
      <div className="message-row__content">
        <div className="message-row__header">
          <span className={`message-row__sender${isUnread ? " message-row__sender--bold" : ""}`}>
            {thread.participants.join(", ")}
          </span>
          <span className="message-row__date">{formatDate(thread.last_date)}</span>
        </div>
        <div className="message-row__meta">
          <span className="message-row__subject">{thread.subject}</span>
          <div className="message-row__badges">
            {thread.flagged && (
              <span className="message-row__flag" aria-label="flagged">
                ⚑
              </span>
            )}
            {thread.message_count > 1 && (
              <span
                className="message-row__count"
                aria-label={`${thread.message_count} messages`}
              >
                {thread.message_count}
              </span>
            )}
            {thread.has_attachments && (
              <span className="message-row__attachment" aria-label="has attachments">
                📎
              </span>
            )}
          </div>
        </div>
        {showSnippet && <span className="message-row__snippet">{thread.snippet}</span>}
      </div>
    </div>
  );
}

function SmartRow({
  row,
  isSelected,
  rowHeight,
  showAvatars,
  showSnippet,
  onSelect,
  highlightTerms,
}: {
  row: SmartMessageRow;
  isSelected: boolean;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  onSelect: (id: number) => void;
  highlightTerms?: string[];
}) {
  const senderLabel = row.from_name ?? row.from_address;

  return (
    <div
      className={`message-row${!row.seen ? " message-row--unread" : ""}${isSelected ? " message-row--selected" : ""}`}
      style={{ height: rowHeight }}
      data-message-id={row.message_id}
      onClick={() => onSelect(row.message_id)}
      role="option"
      aria-selected={isSelected}
    >
      <div className="message-row__indicators">
        {!row.seen && <span className="message-row__unread-dot" aria-label="unread" />}
      </div>
      {showAvatars && <Avatar seed={row.from_address} label={row.from_name ?? row.from_address} />}
      <div className="message-row__content">
        <div className="message-row__header">
          <span
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
            className={`message-row__sender${!row.seen ? " message-row__sender--bold" : ""}`}
          >
            <span
              data-account-dot
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: row.account_color ?? "var(--accent)",
                flexShrink: 0,
              }}
            />
            {senderLabel}
          </span>
          <span className="message-row__date">{formatDate(row.date)}</span>
        </div>
        <div className="message-row__meta">
          <span className="message-row__subject">
            {highlightTerms ? <Highlight text={row.subject} terms={highlightTerms} /> : row.subject}
          </span>
          <div className="message-row__badges">
            {row.flagged && (
              <span className="message-row__flag" aria-label="flagged">
                ⚑
              </span>
            )}
            {row.has_attachments && (
              <span className="message-row__attachment" aria-label="has attachments">
                📎
              </span>
            )}
          </div>
        </div>
        {showSnippet && (
          <span className="message-row__snippet">
            {highlightTerms ? <Highlight text={row.snippet} terms={highlightTerms} /> : row.snippet}
          </span>
        )}
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
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectedMessageId = useUiStore((s) => s.selectedMessageId);
  const density = useUiStore((s) => s.density);
  const showPreview = useUiStore((s) => s.showPreview);
  const showAvatars = useUiStore((s) => s.showAvatars);
  const setSelectedThreadId = useUiStore((s) => s.setSelectedThreadId);
  const setSelectedMessageId = useUiStore((s) => s.setSelectedMessageId);
  const openComposer = useUiStore((s) => s.openComposer);
  const setListContext = useUiStore((s) => s.setListContext);

  const searchActive = useUiStore((s) => s.searchActive);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const debouncedQuery = useDebouncedValue(searchQuery, 200);

  const { data: threads, isLoading: threadsLoading } = useThreads(selectedFolderId);
  const { data: smartRows, isLoading: smartLoading } = useSmartFolder(selectedSmartFolder);
  const { data: searchRows, isLoading: searchLoading } = useSearch(debouncedQuery);

  const isSmartMode = !searchActive && selectedSmartFolder != null;
  const isFlatMode = searchActive || isSmartMode;
  const isLoading = searchActive ? searchLoading : isSmartMode ? smartLoading : threadsLoading;
  const rawItems = searchActive
    ? (searchRows ?? [])
    : isSmartMode
      ? (smartRows ?? [])
      : (threads ?? []);
  const hasSelection = searchActive
    ? true
    : isSmartMode
      ? selectedSmartFolder != null
      : selectedFolderId != null;
  const highlightTerms = useMemo(() => extractTerms(debouncedQuery), [debouncedQuery]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHT[density] ?? ROW_HEIGHT.comfortable;
  const showSnippet = showPreview && density !== "dense";

  const nowSecondsRef = useRef(Math.floor(Date.now() / 1000));
  const nowSeconds = nowSecondsRef.current;

  const entries = useMemo(
    (): ListEntry<ThreadSummary | SmartMessageRow>[] =>
      hasSelection && !isLoading && rawItems.length > 0
        ? isFlatMode
          ? groupIntoEntries(rawItems as SmartMessageRow[], (r) => (r as SmartMessageRow).date, nowSeconds)
          : groupIntoEntries(rawItems as ThreadSummary[], (t) => (t as ThreadSummary).last_date, nowSeconds)
        : [],
    [rawItems, isFlatMode, nowSeconds, hasSelection, isLoading]
  );

  useEffect(() => {
    const ids = isFlatMode
      ? (rawItems as SmartMessageRow[]).map((r) => r.message_id)
      : (rawItems as ThreadSummary[]).map((t) => t.thread_id);
    setListContext(ids, isFlatMode ? "message" : "thread");
  }, [rawItems, isFlatMode, setListContext]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (i) => (entries[i]?.kind === "header" ? HEADER_HEIGHT : rowHeight),
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section className="pane message-list-pane" aria-label="message-list">
      <div className="message-list__header">
        <button
          type="button"
          className="message-list__compose"
          aria-label="New message"
          onClick={() => openComposer(null)}
        >
          <PencilLine size={15} /> Compose
        </button>
        <span className="message-list__sort" aria-disabled="true">
          Newest <ChevronDown size={13} />
        </span>
      </div>

      {searchActive && (
        <div className="message-list__search-banner" role="status">
          <span>
            Results for &ldquo;{searchQuery}&rdquo; ({rawItems.length})
          </span>
          <button
            type="button"
            className="message-list__search-clear"
            aria-label="Clear search"
            onClick={() => clearSearch()}
          >
            ✕
          </button>
        </div>
      )}

      {!hasSelection && (
        <div className="message-list__empty">Select a folder</div>
      )}

      {hasSelection && isLoading && (
        <div className="message-list__scroll" style={{ height: "100%" }}>
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonRow key={i} height={rowHeight} />
          ))}
        </div>
      )}

      {hasSelection && !isLoading && rawItems.length === 0 && (
        <div className="message-list__empty">No messages</div>
      )}

      {hasSelection && !isLoading && rawItems.length > 0 && (
        <div
          ref={scrollContainerRef}
          className="message-list__scroll"
          style={{ height: "100%", overflow: "auto" }}
          role="listbox"
          aria-label="messages"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((virtualItem) => {
              const entry = entries[virtualItem.index];
              if (entry.kind === "header") {
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
                    <div className="message-list__group">{entry.label}</div>
                  </div>
                );
              }
              if (isFlatMode) {
                const row = entry.data as SmartMessageRow;
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
                    <SmartRow
                      row={row}
                      isSelected={selectedMessageId === row.message_id}
                      rowHeight={rowHeight}
                      showAvatars={showAvatars}
                      showSnippet={showSnippet}
                      onSelect={setSelectedMessageId}
                      highlightTerms={searchActive ? highlightTerms : undefined}
                    />
                  </div>
                );
              }
              const thread = entry.data as ThreadSummary;
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
                  <ThreadRow
                    thread={thread}
                    isSelected={selectedThreadId === thread.thread_id}
                    rowHeight={rowHeight}
                    showAvatars={showAvatars}
                    showSnippet={showSnippet}
                    onSelect={setSelectedThreadId}
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
