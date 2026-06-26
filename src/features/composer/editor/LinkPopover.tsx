import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Link as LinkIcon } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";

type LinkPopoverProps = { editor: Editor | null };

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
    if (!editor || !url) {
      close();
      return;
    }
    if (text) {
      editor.chain().focus().insertContent(`<a href="${url}">${text}</a>`).run();
    } else {
      editor.chain().focus().setLink({ href: url }).run();
    }
    close();
  }

  return (
    <div className="link-form">
      <input
        className="link-form__input"
        placeholder="URL"
        aria-label="URL"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <input
        className="link-form__input"
        placeholder="Tekst (opcjonalnie)"
        aria-label="Tekst linku"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="button" className="link-form__submit" onClick={submit}>
        Wstaw
      </button>
    </div>
  );
}
