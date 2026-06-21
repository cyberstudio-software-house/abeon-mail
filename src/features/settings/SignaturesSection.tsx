import { useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Trash2 } from "lucide-react";
import { SafeHtmlFrame } from "../reader/SafeHtmlFrame";
import {
  useAccounts,
  useSignatures,
  useCreateSignature,
  useUpdateSignature,
  useSetDefaultSignature,
  useDeleteSignature,
} from "../../ipc/queries";

type EditMode = "visual" | "html";

export function SignaturesSection() {
  const { data: accounts = [] } = useAccounts();
  const [chosenAccountId, setChosenAccountId] = useState<number | null>(null);
  const accountId = chosenAccountId ?? accounts[0]?.id ?? null;

  const { data: signatures = [] } = useSignatures(accountId);
  const createSignature = useCreateSignature();
  const updateSignature = useUpdateSignature();
  const setDefaultSignature = useSetDefaultSignature();
  const deleteSignature = useDeleteSignature();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<EditMode>("visual");
  const [htmlSource, setHtmlSource] = useState("");
  const editor = useEditor({ extensions: [StarterKit], content: "" });

  useEffect(() => {
    setSelectedId(null);
    setName("");
    setMode("visual");
    setHtmlSource("");
    editor?.commands.setContent("<p></p>");
  }, [accountId, editor]);

  function selectSignature(id: number, sigName: string, html: string, isHtml: boolean) {
    setSelectedId(id);
    setName(sigName);
    if (isHtml) {
      setMode("html");
      setHtmlSource(html);
    } else {
      setMode("visual");
      editor?.commands.setContent(html);
    }
  }

  function startNew() {
    setSelectedId(null);
    setName("");
    setMode("visual");
    setHtmlSource("");
    editor?.commands.setContent("<p></p>");
  }

  function toggleMode() {
    if (mode === "visual") {
      setHtmlSource(editor?.getHTML() ?? "");
      setMode("html");
    } else {
      editor?.commands.setContent(htmlSource || "<p></p>");
      setMode("visual");
    }
  }

  function save() {
    if (accountId == null) return;
    const isHtml = mode === "html";
    const html = isHtml ? htmlSource : editor?.getHTML() ?? "<p></p>";
    const trimmed = name.trim() || "Signature";
    if (selectedId == null) {
      createSignature.mutate({ accountId, name: trimmed, html, makeDefault: signatures.length === 0, isHtml });
    } else {
      updateSignature.mutate({ id: selectedId, name: trimmed, html, accountId, isHtml });
    }
  }

  function remove(id: number) {
    if (accountId == null) return;
    deleteSignature.mutate({ id, accountId });
    if (selectedId === id) startNew();
  }

  return (
    <div className="settings-section">
      <label className="settings-account">
        <span className="settings-account__label">Account</span>
        <select
          className="settings-select"
          aria-label="Signatures account"
          value={accountId ?? ""}
          onChange={(e) => setChosenAccountId(Number(e.target.value))}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </label>

      <ul className="signatures-settings__list">
        {signatures.map((sig) => (
          <li key={sig.id} className="signatures-settings__row">
            <button
              type="button"
              className="signatures-settings__name"
              onClick={() => selectSignature(sig.id, sig.name, sig.html, sig.is_html)}
            >
              {sig.name}
            </button>
            <label className="signatures-settings__default">
              <input
                type="radio"
                name="default-signature"
                aria-label={`Set ${sig.name} as default`}
                checked={sig.is_default}
                onChange={() => setDefaultSignature.mutate({ accountId: accountId!, id: sig.id })}
              />
              Default
            </label>
            <button
              type="button"
              className="settings-btn settings-btn--icon"
              aria-label={`Delete signature ${sig.name}`}
              onClick={() => remove(sig.id)}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>

      <div className="signatures-settings__editor">
        <input
          type="text"
          className="settings-input"
          aria-label="Signature name"
          placeholder="Signature name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="settings-btn"
          aria-pressed={mode === "html"}
          onClick={toggleMode}
        >
          {mode === "html" ? "Visual editor" : "Edit HTML source"}
        </button>
        {mode === "html" ? (
          <>
            <textarea
              className="settings-input signatures-settings__html"
              aria-label="Signature HTML source"
              value={htmlSource}
              onChange={(e) => setHtmlSource(e.target.value)}
            />
            <div className="signatures-settings__preview">
              <SafeHtmlFrame html={htmlSource} title="signature-preview" className="signature-preview-frame" />
            </div>
          </>
        ) : (
          <EditorContent editor={editor} className="signatures-settings__body" />
        )}
        <div className="signatures-settings__actions">
          <button type="button" className="settings-btn" onClick={startNew}>
            New signature
          </button>
          <button type="button" className="settings-btn settings-btn--primary" onClick={save}>
            Save signature
          </button>
        </div>
      </div>
    </div>
  );
}
