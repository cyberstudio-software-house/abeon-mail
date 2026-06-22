import { useUiStore } from "../../app/store";
import type { TimeFormat } from "../../app/store";
import { useDraftSummaries } from "../../ipc/queries";
import { commands } from "../../ipc/bindings";
import { formatListDate } from "../../shared/datetime/datetime";
import type { DraftSummary } from "../../ipc/bindings";

function DraftRow({
  draft,
  timeFormat,
  onOpen,
}: {
  draft: DraftSummary;
  timeFormat: TimeFormat;
  onOpen: (id: number) => void;
}) {
  const recipient = draft.to.length > 0 ? draft.to.join(", ") : "(No recipients)";
  const subject = draft.subject.trim().length > 0 ? draft.subject : "(No subject)";

  return (
    <div
      className="message-row"
      data-draft-id={draft.id}
      onClick={() => onOpen(draft.id)}
      role="option"
      aria-selected={false}
    >
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
        {draft.snippet && <span className="message-row__snippet">{draft.snippet}</span>}
      </div>
    </div>
  );
}

export function DraftsList({ accountId }: { accountId: number | null }) {
  const { data: drafts, isLoading } = useDraftSummaries(accountId);
  const openComposer = useUiStore((s) => s.openComposer);
  const timeFormat = useUiStore((s) => s.timeFormat);

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

  return (
    <div
      className="message-list__scroll"
      style={{ height: "100%", overflow: "auto" }}
      role="listbox"
      aria-label="drafts"
    >
      {drafts.map((draft) => (
        <DraftRow key={draft.id} draft={draft} timeFormat={timeFormat} onOpen={handleOpen} />
      ))}
    </div>
  );
}
