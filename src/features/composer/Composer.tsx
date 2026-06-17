import { useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { commands } from "../../ipc/bindings";
import type { OutgoingAttachment } from "../../ipc/bindings";
import { useAccounts } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { RecipientField } from "./RecipientField";
import "./composer.css";

function unwrapOk<T>(result: { status: "ok"; data: T } | { status: "error"; error: string }): T {
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}

export function Composer() {
  const composer = useUiStore((s) => s.composer);
  const closeComposer = useUiStore((s) => s.closeComposer);
  const { data: accounts = [] } = useAccounts();

  const [fromAccountId, setFromAccountId] = useState<number | null>(null);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
  });

  const accountId = fromAccountId ?? (accounts[0]?.id ?? null);

  const buildMessage = useCallback(() => {
    return {
      from_address: accounts.find((a) => a.id === accountId)?.email ?? "",
      from_name: accounts.find((a) => a.id === accountId)?.display_name ?? null,
      to,
      cc,
      bcc,
      subject,
      text_body: editor?.getText() ?? "",
      html_body: editor?.getHTML() ?? null,
      in_reply_to: null,
      references: [],
      attachments,
    };
  }, [accounts, accountId, to, cc, bcc, subject, editor, attachments]);

  async function handleSend() {
    if (accountId == null) return;
    setIsSending(true);
    try {
      const message = buildMessage();
      const savedId = unwrapOk(await commands.saveDraft(accountId, composer.draftId, message));
      await commands.enqueueSend(savedId);
      closeComposer();
    } finally {
      setIsSending(false);
    }
  }

  async function handleSaveDraft() {
    if (accountId == null) return;
    setIsSavingDraft(true);
    try {
      const message = buildMessage();
      await commands.saveDraft(accountId, composer.draftId, message);
      closeComposer();
    } finally {
      setIsSavingDraft(false);
    }
  }

  async function handlePickAttachment() {
    const result = await commands.pickAttachment();
    if (result.status === "ok") {
      setAttachments((prev) => [...prev, ...result.data]);
    }
  }

  async function handleInsertSignature() {
    if (accountId == null || !editor) return;
    const result = await commands.listSignatures(accountId);
    if (result.status === "ok") {
      const defaultSig = result.data.find((s) => s.is_default) ?? result.data[0];
      if (defaultSig) {
        editor.chain().focus().insertContent(defaultSig.html).run();
      }
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  if (!composer.open) return null;

  return (
    <div className="composer-backdrop" role="dialog" aria-modal="true" aria-label="New message">
      <div className="composer-modal">
        <div className="composer-header">
          <span className="composer-title">New Message</span>
          <button type="button" className="composer-close" aria-label="Close composer" onClick={closeComposer}>
            ×
          </button>
        </div>

        <div className="composer-fields">
          <div className="composer-from">
            <span className="field-label">From</span>
            <select
              className="from-select"
              value={accountId ?? ""}
              onChange={(e) => setFromAccountId(Number(e.target.value))}
              aria-label="From account"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name} &lt;{a.email}&gt;
                </option>
              ))}
            </select>
          </div>

          <RecipientField label="To" recipients={to} onChange={setTo} />

          <div className="composer-cc-bcc-toggles">
            {!showCc && (
              <button type="button" className="toggle-link" onClick={() => setShowCc(true)}>
                Cc
              </button>
            )}
            {!showBcc && (
              <button type="button" className="toggle-link" onClick={() => setShowBcc(true)}>
                Bcc
              </button>
            )}
          </div>

          {showCc && <RecipientField label="Cc" recipients={cc} onChange={setCc} />}
          {showBcc && <RecipientField label="Bcc" recipients={bcc} onChange={setBcc} />}

          <div className="composer-subject">
            <span className="field-label">Subject</span>
            <input
              type="text"
              className="subject-input"
              aria-label="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
            />
          </div>
        </div>

        <div className="composer-toolbar">
          <button
            type="button"
            className={`toolbar-btn${editor?.isActive("bold") ? " active" : ""}`}
            aria-label="Bold"
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            className={`toolbar-btn${editor?.isActive("italic") ? " active" : ""}`}
            aria-label="Italic"
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <em>I</em>
          </button>
          <button
            type="button"
            className={`toolbar-btn${editor?.isActive("bulletList") ? " active" : ""}`}
            aria-label="Bullet list"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            ≡
          </button>
          <button
            type="button"
            className="toolbar-btn"
            aria-label="Insert link"
            onClick={() => {
              const url = window.prompt("URL");
              if (url) {
                editor?.chain().focus().setLink({ href: url }).run();
              }
            }}
          >
            🔗
          </button>
        </div>

        <div className="composer-editor">
          <EditorContent editor={editor} />
        </div>

        <div className="composer-attachments">
          <button type="button" className="attach-btn" onClick={handlePickAttachment}>
            Attach file
          </button>
          {attachments.map((att, i) => (
            <span key={att.blob_ref} className="attachment-chip">
              {att.filename}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${att.filename}`}
                onClick={() => removeAttachment(i)}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        <div className="composer-footer">
          <button
            type="button"
            className="btn-send"
            disabled={isSending || accountId == null}
            onClick={handleSend}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            className="btn-draft"
            disabled={isSavingDraft || accountId == null}
            onClick={handleSaveDraft}
          >
            Save draft
          </button>
          <button type="button" className="btn-signature" onClick={handleInsertSignature}>
            Insert signature
          </button>
          <button type="button" className="btn-discard" onClick={closeComposer}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
