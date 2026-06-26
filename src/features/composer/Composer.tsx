import { useState, useCallback, useRef, useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { createEditorExtensions } from "./editor/extensions";
import { EditorToolbar } from "./editor/EditorToolbar";
import { commands } from "../../ipc/bindings";
import type { OutgoingAttachment, Signature } from "../../ipc/bindings";
import { useAccounts, useSaveDraft, useEnqueueSend, useDiscardDraft } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { RecipientField } from "./RecipientField";
import { SafeHtmlFrame } from "../reader/SafeHtmlFrame";
import "./composer.css";

const AUTOSAVE_DELAY_MS = 1500;

let inlineImageCounter = 0;

function generateContentId(): string {
  inlineImageCounter += 1;
  return `inline-${inlineImageCounter}@abeonmail`;
}

function rewriteInlineSrcs(html: string, srcToContentId: Map<string, string>): string {
  return html.replace(/<img([^>]*)\ssrc="([^"]*)"([^>]*)>/g, (match, before, src, after) => {
    const contentId = srcToContentId.get(src);
    if (contentId) {
      return `<img${before} src="cid:${contentId}"${after}>`;
    }
    return match;
  });
}

function htmlToText(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent ?? "";
}

function resolveInitialFromAccount(isBlankCompose: boolean, activeAccountId: number | null): number | null {
  return isBlankCompose ? activeAccountId : null;
}

function buildInitialContent(htmlBody: string | null | undefined, isReplyOrForward: boolean): string {
  if (!htmlBody) return "";
  return isReplyOrForward ? `<p></p>${htmlBody}` : htmlBody;
}

export function Composer() {
  const composer = useUiStore((s) => s.composer);
  const closeComposer = useUiStore((s) => s.closeComposer);
  const setComposerSend = useUiStore((s) => s.setComposerSend);
  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const { data: accounts = [] } = useAccounts();

  const prefill = composer.prefill;
  const isBlankCompose = composer.draftId == null && prefill == null;

  const [fromAccountId, setFromAccountId] = useState<number | null>(() => resolveInitialFromAccount(isBlankCompose, selectedAccountId));
  const [to, setTo] = useState<string[]>(prefill?.to ?? []);
  const [cc, setCc] = useState<string[]>(prefill?.cc ?? []);
  const [bcc, setBcc] = useState<string[]>(prefill?.bcc ?? []);
  const [subject, setSubject] = useState(prefill?.subject ?? "");
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>(prefill?.attachments ?? []);
  const [showCc, setShowCc] = useState((prefill?.cc ?? []).length > 0);
  const [showBcc, setShowBcc] = useState((prefill?.bcc ?? []).length > 0);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const inlineSrcMapRef = useRef<Map<string, string>>(new Map());

  const draftIdRef = useRef<number | null>(composer.draftId);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveDraftMutation = useSaveDraft();
  const enqueueSendMutation = useEnqueueSend();
  const discardDraftMutation = useDiscardDraft();

  const accountId = fromAccountId ?? (accounts[0]?.id ?? null);

  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: buildInitialContent(prefill?.html_body, composer.draftId == null),
  });

  useEffect(() => {
    if (prefill?.html_body && editor) {
      editor.commands.setContent(buildInitialContent(prefill.html_body, composer.draftId == null));
      if (composer.draftId == null) {
        editor.commands.focus("start");
      }
    }
  }, [prefill?.html_body, editor, composer.draftId]);

  const [signatures, setSignatures] = useState<Signature[]>([]);
  const signatureInsertedRef = useRef(false);
  const [activeHtmlSignature, setActiveHtmlSignature] = useState<Signature | null>(null);
  const [signatureExpanded, setSignatureExpanded] = useState(false);

  useEffect(() => {
    if (accountId == null) return;
    let cancelled = false;
    commands.listSignatures(accountId).then((result) => {
      if (!cancelled && result.status === "ok") setSignatures(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (signatureInsertedRef.current) return;
    if (!editor) return;
    if (signatures.length === 0) return;
    signatureInsertedRef.current = true;
    const sig = signatures.find((s) => s.is_default);
    if (!sig) return;
    if (sig.is_html) {
      setActiveHtmlSignature(sig);
      return;
    }
    if (composer.draftId != null) return;
    const quote = prefill?.html_body ?? "";
    editor.commands.setContent(`<p></p>${sig.html}${quote}`);
    editor.commands.focus("start");
  }, [editor, signatures, composer.draftId, prefill?.html_body]);

  function insertSignature(html: string) {
    if (!editor) return;
    editor.chain().focus().insertContent(html).run();
    scheduleAutosave();
  }

  const buildMessage = useCallback(
    (forSend: boolean) => {
      const rawHtml = editor?.getHTML() ?? null;
      let html_body = rawHtml ? rewriteInlineSrcs(rawHtml, inlineSrcMapRef.current) : null;
      let text_body = editor?.getText() ?? "";
      if (forSend && activeHtmlSignature) {
        html_body = `${html_body ?? ""}${activeHtmlSignature.html}`;
        text_body = `${text_body}\n\n${htmlToText(activeHtmlSignature.html)}`;
      }
      return {
        from_address: accounts.find((a) => a.id === accountId)?.email ?? "",
        from_name: accounts.find((a) => a.id === accountId)?.display_name ?? null,
        to,
        cc,
        bcc,
        subject,
        text_body,
        html_body,
        in_reply_to: prefill?.in_reply_to ?? null,
        references: prefill?.references ?? [],
        attachments,
      };
    },
    [accounts, accountId, to, cc, bcc, subject, editor, attachments, prefill, activeHtmlSignature],
  );

  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = setTimeout(async () => {
      if (accountId == null) return;
      const message = buildMessage(false);
      const savedId = await saveDraftMutation.mutateAsync({
        accountId,
        draftId: draftIdRef.current,
        message,
      });
      draftIdRef.current = savedId;
    }, AUTOSAVE_DELAY_MS);
  }, [accountId, buildMessage, saveDraftMutation]);

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
    };
  }, []);

  async function handleSend() {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (accountId == null) return;
    setIsSending(true);
    setSendError(null);
    try {
      const message = buildMessage(true);
      const savedId = await saveDraftMutation.mutateAsync({
        accountId,
        draftId: draftIdRef.current,
        message,
      });
      draftIdRef.current = savedId;
      await enqueueSendMutation.mutateAsync(savedId);
      useUiStore.getState().markSendStarted();
      closeComposer();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSending(false);
    }
  }

  async function handleSaveDraft() {
    if (accountId == null) return;
    const message = buildMessage(false);
    const savedId = await saveDraftMutation.mutateAsync({
      accountId,
      draftId: draftIdRef.current,
      message,
    });
    draftIdRef.current = savedId;
    closeComposer();
  }

  async function handleDiscard() {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    if (draftIdRef.current != null) {
      await discardDraftMutation.mutateAsync(draftIdRef.current);
    }
    closeComposer();
  }

  async function handlePickAttachment() {
    const result = await commands.pickAttachment();
    if (result.status === "ok") {
      setAttachments((prev) => [...prev, ...result.data]);
      scheduleAutosave();
    }
  }

  async function handleInsertImage() {
    if (!editor) return;
    const result = await commands.pickAttachment();
    if (result.status !== "ok" || result.data.length === 0) return;
    const inlineAttachments: OutgoingAttachment[] = result.data.map((att) => {
      const contentId = att.content_id ?? generateContentId();
      return { ...att, content_id: contentId };
    });
    const previewSrc = inlineAttachments[0].blob_ref;
    const contentId = inlineAttachments[0].content_id as string;
    inlineSrcMapRef.current.set(previewSrc, contentId);
    editor.chain().focus().setImage({ src: previewSrc }).run();
    setAttachments((prev) => [...prev, ...inlineAttachments]);
    scheduleAutosave();
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    scheduleAutosave();
  }

  function handleToChange(value: string[]) {
    setTo(value);
    scheduleAutosave();
  }

  function handleCcChange(value: string[]) {
    setCc(value);
    scheduleAutosave();
  }

  function handleBccChange(value: string[]) {
    setBcc(value);
    scheduleAutosave();
  }

  function handleSubjectChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSubject(e.target.value);
    scheduleAutosave();
  }

  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  useEffect(() => {
    setComposerSend(() => {
      void handleSendRef.current();
    });
    return () => setComposerSend(null);
  }, [setComposerSend]);

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

          <RecipientField label="To" recipients={to} onChange={handleToChange} />

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

          {showCc && <RecipientField label="Cc" recipients={cc} onChange={handleCcChange} />}
          {showBcc && <RecipientField label="Bcc" recipients={bcc} onChange={handleBccChange} />}

          <div className="composer-subject">
            <span className="field-label">Subject</span>
            <input
              type="text"
              className="subject-input"
              aria-label="Subject"
              value={subject}
              onChange={handleSubjectChange}
              placeholder="Subject"
            />
          </div>
        </div>

        <EditorToolbar editor={editor} onInsertImage={handleInsertImage} />

        <div className="composer-editor">
          <EditorContent editor={editor} />
        </div>

        {activeHtmlSignature && (
          <div
            className={`composer-signature-preview${
              signatureExpanded ? " composer-signature-preview--expanded" : ""
            }`}
          >
            <div className="composer-signature-preview__header">
              <button
                type="button"
                className="composer-signature-preview__toggle"
                aria-expanded={signatureExpanded}
                onClick={() => setSignatureExpanded((value) => !value)}
              >
                <span className="composer-signature-preview__chevron" aria-hidden="true">
                  ›
                </span>
                <span className="composer-signature-preview__label">Signature preview</span>
              </button>
              <button
                type="button"
                className="signature-remove"
                aria-label="Remove signature"
                onClick={() => setActiveHtmlSignature(null)}
              >
                × Remove
              </button>
            </div>
            {signatureExpanded && (
              <SafeHtmlFrame
                html={activeHtmlSignature.html}
                title="signature-preview"
                className="signature-preview-frame"
              />
            )}
          </div>
        )}

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

        {sendError && (
          <div className="composer-send-error" role="alert">
            {sendError}
          </div>
        )}

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
            disabled={saveDraftMutation.isPending || accountId == null}
            onClick={handleSaveDraft}
          >
            Save draft
          </button>
          {signatures.length > 0 && (
            <select
              className="btn-signature"
              aria-label="Insert signature"
              value=""
              onChange={(e) => {
                const sig = signatures.find((s) => String(s.id) === e.target.value);
                if (sig) {
                  if (sig.is_html) {
                    setActiveHtmlSignature(sig);
                  } else {
                    insertSignature(sig.html);
                  }
                }
                e.currentTarget.value = "";
              }}
            >
              <option value="">Insert signature…</option>
              {signatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn-discard" onClick={handleDiscard}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
