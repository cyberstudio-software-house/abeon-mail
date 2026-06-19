import { useRef, useMemo, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PencilLine, ChevronDown } from "lucide-react";
import { useThreads, useSmartFolder, useSearch, useLabelsForMessages, useMessagesByLabel, useLabels, useUnsnooze } from "../../ipc/queries";
import { formatListDate, formatWakeTime } from "../../shared/datetime/datetime";
import { useDebouncedValue } from "../../shared/hooks/useDebouncedValue";
import { useUiStore, type Density } from "../../app/store";
import type { ThreadSummary, SmartMessageRow, Label } from "../../ipc/bindings";
import { LabelChips } from "../labels/LabelChips";
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
  const timeFormat = useUiStore((s) => s.timeFormat);
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
          <span className="message-row__date">{formatListDate(thread.last_date, timeFormat)}</span>
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
  labels,
  selectable,
  selected,
  onToggleSelect,
  wakeAt,
}: {
  row: SmartMessageRow;
  isSelected: boolean;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  onSelect: (id: number) => void;
  highlightTerms?: string[];
  labels?: Label[];
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  wakeAt?: number | null;
}) {
  const timeFormat = useUiStore((s) => s.timeFormat);
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
        {selectable && (
          <input
            type="checkbox"
            aria-label="Select message"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(row.message_id)}
          />
        )}
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
          <span className="message-row__date">{formatListDate(row.date, timeFormat)}</span>
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
            {labels && labels.length > 0 && <LabelChips labels={labels} />}
            {wakeAt != null && (
              <span className="message-row__snooze" data-testid="snooze-wake">
                {formatWakeTime(wakeAt, timeFormat)}
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
  const selectedLabelId = useUiStore((s) => s.selectedLabelId);
  const selectionActive = useUiStore((s) => s.selectionActive);
  const selectedMessageIds = useUiStore((s) => s.selectedMessageIds);
  const toggleSelectionMode = useUiStore((s) => s.toggleSelectionMode);
  const toggleMessageSelected = useUiStore((s) => s.toggleMessageSelected);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
  const openSnoozePicker = useUiStore((s) => s.openSnoozePicker);
  const debouncedQuery = useDebouncedValue(searchQuery, 200);

  const unsnooze = useUnsnooze();

  const { data: threads, isLoading: threadsLoading } = useThreads(selectedFolderId);
  const { data: smartRows, isLoading: smartLoading } = useSmartFolder(selectedSmartFolder);
  const { data: searchRows, isLoading: searchLoading } = useSearch(debouncedQuery);
  const { data: labelRows, isLoading: labelLoading } = useMessagesByLabel(selectedLabelId);
  const { data: allLabels } = useLabels();

  const isLabelMode = !searchActive && selectedLabelId != null;
  const isSmartMode = !searchActive && !isLabelMode && selectedSmartFolder != null;
  const isFlatMode = searchActive || isLabelMode || isSmartMode;
  const isSnoozedView = isSmartMode && selectedSmartFolder === "snoozed";
  const isLoading = searchActive
    ? searchLoading
    : isLabelMode
      ? labelLoading
      : isSmartMode
        ? smartLoading
        : threadsLoading;
  const rawItems = searchActive
    ? (searchRows ?? [])
    : isLabelMode
      ? (labelRows ?? [])
      : isSmartMode
        ? (smartRows ?? [])
        : (threads ?? []);
  const hasSelection = searchActive
    ? true
    : isLabelMode
      ? selectedLabelId != null
      : isSmartMode
        ? selectedSmartFolder != null
        : selectedFolderId != null;
  const activeLabel = allLabels?.find((l) => l.id === selectedLabelId);
  const highlightTerms = useMemo(() => extractTerms(debouncedQuery), [debouncedQuery]);

  const flatMessageIds = useMemo(
    () => (isFlatMode ? (rawItems as SmartMessageRow[]).map((r) => r.message_id) : []),
    [rawItems, isFlatMode]
  );
  const { data: labelPairs } = useLabelsForMessages(flatMessageIds);
  const labelsByMessage = useMemo(() => {
    const map = new Map<number, Label[]>();
    for (const [mid, label] of labelPairs ?? []) {
      const arr = map.get(mid) ?? [];
      arr.push(label);
      map.set(mid, arr);
    }
    return map;
  }, [labelPairs]);

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
        {isFlatMode && (
          <button
            type="button"
            className="message-list__select-toggle"
            onClick={() => toggleSelectionMode()}
          >
            {selectionActive ? "Done" : "Select"}
          </button>
        )}
      </div>

      {isFlatMode && selectionActive && (
        <div className="message-list__selection-bar" role="toolbar" aria-label="Selection actions">
          <span>{selectedMessageIds.length} selected</span>
          <button
            type="button"
            disabled={selectedMessageIds.length === 0}
            onClick={() => openLabelPicker(selectedMessageIds)}
          >
            Label
          </button>
          {isSnoozedView ? (
            <button
              type="button"
              disabled={selectedMessageIds.length === 0}
              onClick={() => {
                unsnooze.mutate(selectedMessageIds);
                clearSelection();
              }}
            >
              Unsnooze
            </button>
          ) : (
            <button
              type="button"
              disabled={selectedMessageIds.length === 0}
              onClick={() => openSnoozePicker(selectedMessageIds)}
            >
              Snooze
            </button>
          )}
          <button type="button" onClick={() => clearSelection()}>
            Cancel
          </button>
        </div>
      )}

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

      {isLabelMode && activeLabel && (
        <div className="message-list__search-banner" role="status">
          <span>
            Label: {activeLabel.name} ({rawItems.length})
          </span>
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
                      labels={labelsByMessage.get(row.message_id)}
                      wakeAt={row.snooze_wake_at}
                      selectable={selectionActive}
                      selected={selectedMessageIds.includes(row.message_id)}
                      onToggleSelect={toggleMessageSelected}
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
