import { useUiStore } from "../../app/store";
import type { TimeFormat } from "../../app/store";
import { useDraftSummaries } from "../../ipc/queries";
import { commands } from "../../ipc/bindings";
import { formatListDate } from "../../shared/datetime/datetime";
import { Avatar } from "../../shared/appearance/Avatar";
import { groupIntoEntries } from "./grouping";
import { ROW_HEIGHT } from "./rowMetrics";
import type { DraftSummary } from "../../ipc/bindings";

function DraftRow({
  draft,
  rowHeight,
  showAvatars,
  showSnippet,
  timeFormat,
  onOpen,
}: {
  draft: DraftSummary;
  rowHeight: number;
  showAvatars: boolean;
  showSnippet: boolean;
  timeFormat: TimeFormat;
  onOpen: (id: number) => void;
}) {
  const recipient = draft.to.length > 0 ? draft.to.join(", ") : "(No recipients)";
  const subject = draft.subject.trim().length > 0 ? draft.subject : "(No subject)";

  return (
    <div
      className="message-row"
      style={{ height: rowHeight }}
      data-draft-id={draft.id}
      onClick={() => onOpen(draft.id)}
      role="option"
      aria-selected={false}
    >
      <div className="message-row__indicators" />
      {showAvatars && <Avatar seed={draft.to[0] ?? draft.subject} label={recipient} />}
      <div className="message-row__content">
        <div className="message-row__header">
          <span className="message-row__sender">{recipient}</span>
          <span className="message-row__date">{formatListDate(draft.date, timeFormat)}</span>
        </div>
        <div className="message-row__meta">
          <span className="message-row__subject">{subject}</span>
          <div className="message-row__badges">
            {draft.has_attachments && (
              <span className="message-row__attachment" aria-label="has attachments">
                📎
              </span>
            )}
          </div>
        </div>
        {showSnippet && draft.snippet && <span className="message-row__snippet">{draft.snippet}</span>}
      </div>
    </div>
  );
}

export function DraftsList({ accountId }: { accountId: number | null }) {
  const { data: drafts, isLoading } = useDraftSummaries(accountId);
  const openComposer = useUiStore((s) => s.openComposer);
  const density = useUiStore((s) => s.density);
  const showAvatars = useUiStore((s) => s.showAvatars);
  const showPreview = useUiStore((s) => s.showPreview);
  const timeFormat = useUiStore((s) => s.timeFormat);

  const rowHeight = ROW_HEIGHT[density] ?? ROW_HEIGHT.comfortable;
  const showSnippet = showPreview && density !== "dense";

  async function handleOpen(id: number) {
    const result = await commands.getDraft(id);
    if (result.status === "ok") {
      openComposer(id, result.data);
    }
  }

  if (isLoading) {
    return <div className="message-list__scroll" style={{ height: "100%" }} />;
  }

  if (!drafts || drafts.length === 0) {
    return <div className="message-list__empty">No drafts</div>;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const entries = groupIntoEntries(drafts, (d) => d.date, nowSeconds);

  return (
    <div
      className="message-list__scroll"
      style={{ height: "100%", overflow: "auto" }}
      role="listbox"
      aria-label="drafts"
    >
      {entries.map((entry, index) =>
        entry.kind === "header" ? (
          <div className="message-list__group" key={`h-${index}`}>
            {entry.label}
          </div>
        ) : (
          <DraftRow
            key={entry.data.id}
            draft={entry.data}
            rowHeight={rowHeight}
            showAvatars={showAvatars}
            showSnippet={showSnippet}
            timeFormat={timeFormat}
            onOpen={handleOpen}
          />
        )
      )}
    </div>
  );
}
