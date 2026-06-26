import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Link as LinkIcon } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";

type LinkPopoverProps = { editor: Editor | null };

const ALLOWED_SCHEME = /^(https?:|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (ALLOWED_SCHEME.test(trimmed)) return trimmed;
  if (HAS_SCHEME.test(trimmed)) return null;
  return `https://${trimmed}`;
}

export function LinkPopover({ editor }: LinkPopoverProps) {
  return (
    <ToolbarPopover trigger={<LinkIcon size={16} />} label="Wstaw link" disabled={!editor}>
      {(close) => <LinkForm editor={editor} close={close} />}
    </ToolbarPopover>
  );
}

function LinkForm({ editor, close }: { editor: Editor | null; close: () => void }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");

  function submit() {
    const href = editor ? normalizeUrl(url) : null;
    if (!editor || !href) {
      close();
      return;
    }
    if (text) {
      editor.chain().focus().insertContent({ type: "text", text, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      editor.chain().focus().setLink({ href }).run();
    }
    close();
  }

  return (
    <div className="link-form">
      <input className="link-form__input" placeholder="URL" aria-label="URL" value={url} onChange={(event) => setUrl(event.target.value)} />
      <input className="link-form__input" placeholder="Tekst (opcjonalnie)" aria-label="Tekst linku" value={text} onChange={(event) => setText(event.target.value)} />
      <button type="button" className="link-form__submit" onClick={submit}>
        Wstaw
      </button>
    </div>
  );
}
