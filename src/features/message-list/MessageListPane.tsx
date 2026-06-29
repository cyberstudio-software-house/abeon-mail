import { useRef, useMemo, useEffect, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PencilLine, Reply } from "lucide-react";
import { useThreads, useFolders, useSmartFolder, useSearch, useLabelsForMessages, useMessagesByLabel, useLabels } from "../../ipc/queries";
import { DraftsList } from "./DraftsList";
import { FilterSortMenu } from "./FilterSortMenu";
import { formatListDate, formatWakeTime } from "../../shared/datetime/datetime";
import { useDebouncedValue } from "../../shared/hooks/useDebouncedValue";
import { useUiStore } from "../../app/store";
import type { ThreadSummary, SmartMessageRow, Label, ThreadListFilters } from "../../ipc/bindings";
import { LabelChips } from "../labels/LabelChips";
import { Avatar } from "../../shared/appearance/Avatar";
import { groupIntoEntries, type ListEntry } from "./grouping";
import { extractTerms, Highlight } from "./highlight";
import { ROW_HEIGHT, HEADER_HEIGHT } from "./rowMetrics";
import "./MessageListPane.css";

function ThreadRow({
  thread,
  isSelected,
  rowHeight,
  showAvatars,
  showSnippet,
  onClick,
}: {
  thread: ThreadSummary;
  isSelected: boolean;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  onClick: (e: ReactMouseEvent, id: number) => void;
}) {
  const timeFormat = useUiStore((s) => s.timeFormat);
  const isUnread = thread.unread_count > 0;

  return (
    <div
      className={`message-row${isUnread ? " message-row--unread" : ""}${isSelected ? " message-row--selected" : ""}`}
      style={{ height: rowHeight }}
      data-thread-id={thread.thread_id}
      onClick={(e) => onClick(e, thread.thread_id)}
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
            {thread.answered && (
              <span className="message-row__answered" title="Odpowiedziano" aria-label="Odpowiedziano">
                <Reply size={14} />
              </span>
            )}
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
  onClick,
  highlightTerms,
  labels,
  wakeAt,
}: {
  row: SmartMessageRow;
  isSelected: boolean;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  onClick: (e: ReactMouseEvent, id: number) => void;
  highlightTerms?: string[];
  labels?: Label[];
  wakeAt?: number | null;
}) {
  const timeFormat = useUiStore((s) => s.timeFormat);
  const senderLabel = row.from_name ?? row.from_address;

  return (
    <div
      className={`message-row${!row.seen ? " message-row--unread" : ""}${isSelected ? " message-row--selected" : ""}`}
      style={{ height: rowHeight }}
      data-message-id={row.message_id}
      onClick={(e) => onClick(e, row.message_id)}
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
  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const density = useUiStore((s) => s.density);
  const showPreview = useUiStore((s) => s.showPreview);
  const showAvatars = useUiStore((s) => s.showAvatars);
  const openComposer = useUiStore((s) => s.openComposer);
  const setListContext = useUiStore((s) => s.setListContext);

  const selectedRowIds = useUiStore((s) => s.selectedRowIds);
  const selectRow = useUiStore((s) => s.selectRow);
  const toggleRow = useUiStore((s) => s.toggleRow);
  const selectRangeTo = useUiStore((s) => s.selectRangeTo);

  const searchActive = useUiStore((s) => s.searchActive);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const selectedLabelId = useUiStore((s) => s.selectedLabelId);
  const debouncedQuery = useDebouncedValue(searchQuery, 200);

  const listSortDir = useUiStore((s) => s.listSortDir);
  const listFilterSender = useUiStore((s) => s.listFilterSender);
  const listFilterSubject = useUiStore((s) => s.listFilterSubject);
  const listFilterAttachmentsOnly = useUiStore((s) => s.listFilterAttachmentsOnly);
  const clearListFilters = useUiStore((s) => s.clearListFilters);

  const debouncedSender = useDebouncedValue(listFilterSender, 200);
  const debouncedSubject = useDebouncedValue(listFilterSubject, 200);

  const threadFilters = useMemo<ThreadListFilters>(() => {
    const trimmedSender = debouncedSender.trim();
    const trimmedSubject = debouncedSubject.trim();
    return {
      sort_dir: listSortDir,
      sender: trimmedSender === "" ? null : trimmedSender,
      subject: trimmedSubject === "" ? null : trimmedSubject,
      attachments_only: listFilterAttachmentsOnly,
    };
  }, [listSortDir, debouncedSender, debouncedSubject, listFilterAttachmentsOnly]);

  function handleRowClick(e: ReactMouseEvent, rowId: number) {
    if (e.shiftKey) selectRangeTo(rowId);
    else if (e.metaKey || e.ctrlKey) toggleRow(rowId);
    else selectRow(rowId);
  }

  const { data: threads, isLoading: threadsLoading } = useThreads(selectedFolderId, threadFilters);
  const { data: smartRows, isLoading: smartLoading } = useSmartFolder(selectedSmartFolder);
  const { data: searchRows, isLoading: searchLoading } = useSearch(debouncedQuery);
  const { data: labelRows, isLoading: labelLoading } = useMessagesByLabel(selectedLabelId);
  const { data: allLabels } = useLabels();
  const { data: folders } = useFolders(selectedAccountId);

  const selectedFolder = folders?.find((f) => f.id === selectedFolderId);
  const isDraftsMode =
    !searchActive &&
    selectedLabelId == null &&
    selectedSmartFolder == null &&
    selectedFolder?.folder_type === "drafts";

  const isLabelMode = !searchActive && selectedLabelId != null;
  const isSmartMode = !searchActive && !isLabelMode && selectedSmartFolder != null;
  const isFlatMode = searchActive || isLabelMode || isSmartMode;
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
    const accounts: Record<number, number> = {};
    if (isFlatMode) {
      for (const r of rawItems as SmartMessageRow[]) accounts[r.message_id] = r.account_id;
    } else {
      for (const t of rawItems as ThreadSummary[]) accounts[t.thread_id] = t.account_id;
    }
    const ids = isFlatMode
      ? (rawItems as SmartMessageRow[]).map((r) => r.message_id)
      : (rawItems as ThreadSummary[]).map((t) => t.thread_id);
    setListContext(ids, isFlatMode ? "message" : "thread", accounts);
  }, [rawItems, isFlatMode, setListContext]);

  useEffect(() => {
    clearListFilters();
  }, [selectedFolderId, clearListFilters]);

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
        {!isFlatMode && !isDraftsMode && <FilterSortMenu />}
      </div>

      {isDraftsMode ? (
        <DraftsList accountId={selectedAccountId} />
      ) : (
      <>
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
        !isFlatMode && (listFilterSender !== "" || listFilterSubject !== "" || listFilterAttachmentsOnly) ? (
          <div className="message-list__empty">
            No messages match your filters
            <button
              type="button"
              className="list-filter__clear"
              onClick={() => clearListFilters()}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="message-list__empty">No messages</div>
        )
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
                      isSelected={selectedRowIds.includes(row.message_id)}
                      rowHeight={rowHeight}
                      showAvatars={showAvatars}
                      showSnippet={showSnippet}
                      onClick={handleRowClick}
                      highlightTerms={searchActive ? highlightTerms : undefined}
                      labels={labelsByMessage.get(row.message_id)}
                      wakeAt={row.snooze_wake_at}
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
                    isSelected={selectedRowIds.includes(thread.thread_id)}
                    rowHeight={rowHeight}
                    showAvatars={showAvatars}
                    showSnippet={showSnippet}
                    onClick={handleRowClick}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
      </>
      )}
    </section>
  );
}
