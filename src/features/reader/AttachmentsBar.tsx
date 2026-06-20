import { Paperclip, Download } from "lucide-react";
import { useMessageAttachments } from "../../ipc/queries";
import { commands } from "../../ipc/bindings";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsBar({ messageId }: { messageId: number }) {
  const { data: attachments = [] } = useMessageAttachments(messageId);

  if (attachments.length === 0) return null;

  return (
    <div className="attachments-bar">
      {attachments.map((a) => (
        <div key={a.id} className="attachment-tile">
          <button
            type="button"
            className="attachment-tile__open"
            aria-label={`Open ${a.filename}`}
            onClick={() => commands.openAttachment(a.id)}
          >
            <Paperclip size={18} className="attachment-tile__icon" />
            <span className="attachment-tile__meta">
              <span className="attachment-tile__name">{a.filename}</span>
              <span className="attachment-tile__size">{formatSize(a.size)}</span>
            </span>
          </button>
          <button
            type="button"
            className="attachment-tile__save"
            aria-label={`Save ${a.filename}`}
            onClick={() => commands.saveAttachment(a.id)}
          >
            <Download size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
