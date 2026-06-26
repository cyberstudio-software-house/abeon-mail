import type { ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold, Italic, Underline, Strikethrough, Type, Palette, Highlighter,
  Heading, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, ListChecks, Quote, Code, Minus,
  Image as ImageIcon, RemoveFormatting, ChevronDown,
} from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import { ColorSwatchGrid } from "./ColorSwatchGrid";
import { TableMenu } from "./TableMenu";
import { LinkPopover } from "./LinkPopover";
import { FONT_FAMILIES, FONT_SIZE_PRESETS } from "./fontPresets";

type EditorToolbarProps = {
  editor: Editor | null;
  onInsertImage: () => void;
};

function ToolbarButton(props: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`toolbar-btn${props.active ? " active" : ""}`}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

const HEADINGS = [
  { label: "Tekst zwykły", level: 0 },
  { label: "Nagłówek 1", level: 1 },
  { label: "Nagłówek 2", level: 2 },
  { label: "Nagłówek 3", level: 3 },
] as const;

const ALIGNMENTS = [
  { label: "Do lewej", value: "left", Icon: AlignLeft },
  { label: "Wyśrodkuj", value: "center", Icon: AlignCenter },
  { label: "Do prawej", value: "right", Icon: AlignRight },
  { label: "Wyjustuj", value: "justify", Icon: AlignJustify },
] as const;

export function EditorToolbar({ editor, onInsertImage }: EditorToolbarProps) {
  const disabled = !editor;

  return (
    <div className="composer-toolbar" role="toolbar" aria-label="Formatowanie">
      <ToolbarPopover trigger={<><Type size={16} /><ChevronDown size={12} /></>} label="Czcionka" disabled={disabled}>
        {(close) => (
          <div className="toolbar-menu">
            {FONT_FAMILIES.map((font) => (
              <button
                key={font.label}
                type="button"
                className="toolbar-menu__item"
                style={{ fontFamily: font.value ?? undefined }}
                onClick={() => {
                  if (editor) {
                    if (font.value) editor.chain().focus().setFontFamily(font.value).run();
                    else editor.chain().focus().unsetFontFamily().run();
                  }
                  close();
                }}
              >
                {font.label}
              </button>
            ))}
          </div>
        )}
      </ToolbarPopover>

      <ToolbarPopover trigger={<>A<ChevronDown size={12} /></>} label="Rozmiar czcionki" disabled={disabled}>
        {(close) => (
          <div className="toolbar-menu">
            {FONT_SIZE_PRESETS.map((size) => (
              <button
                key={size.label}
                type="button"
                className="toolbar-menu__item"
                onClick={() => {
                  if (editor) {
                    if (size.value) editor.chain().focus().setFontSize(size.value).run();
                    else editor.chain().focus().unsetFontSize().run();
                  }
                  close();
                }}
              >
                {size.label}
              </button>
            ))}
          </div>
        )}
      </ToolbarPopover>

      <ToolbarButton label="Pogrubienie" active={editor?.isActive("bold")} disabled={disabled} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></ToolbarButton>
      <ToolbarButton label="Kursywa" active={editor?.isActive("italic")} disabled={disabled} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></ToolbarButton>
      <ToolbarButton label="Podkreślenie" active={editor?.isActive("underline")} disabled={disabled} onClick={() => editor?.chain().focus().toggleUnderline().run()}><Underline size={16} /></ToolbarButton>
      <ToolbarButton label="Przekreślenie" active={editor?.isActive("strike")} disabled={disabled} onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></ToolbarButton>

      <ToolbarPopover trigger={<><Palette size={16} /><ChevronDown size={12} /></>} label="Kolor tekstu" disabled={disabled}>
        {(close) => (
          <ColorSwatchGrid
            onPick={(color) => { editor?.chain().focus().setColor(color).run(); close(); }}
            onReset={() => { editor?.chain().focus().unsetColor().run(); close(); }}
          />
        )}
      </ToolbarPopover>

      <ToolbarPopover trigger={<><Highlighter size={16} /><ChevronDown size={12} /></>} label="Kolor tła" disabled={disabled}>
        {(close) => (
          <ColorSwatchGrid
            onPick={(color) => { editor?.chain().focus().toggleHighlight({ color }).run(); close(); }}
            onReset={() => { editor?.chain().focus().unsetHighlight().run(); close(); }}
          />
        )}
      </ToolbarPopover>

      <ToolbarPopover trigger={<><Heading size={16} /><ChevronDown size={12} /></>} label="Nagłówek" disabled={disabled}>
        {(close) => (
          <div className="toolbar-menu">
            {HEADINGS.map((heading) => (
              <button
                key={heading.level}
                type="button"
                className="toolbar-menu__item"
                onClick={() => {
                  if (editor) {
                    if (heading.level === 0) editor.chain().focus().setParagraph().run();
                    else editor.chain().focus().toggleHeading({ level: heading.level as 1 | 2 | 3 }).run();
                  }
                  close();
                }}
              >
                {heading.label}
              </button>
            ))}
          </div>
        )}
      </ToolbarPopover>

      <ToolbarPopover trigger={<><AlignLeft size={16} /><ChevronDown size={12} /></>} label="Wyrównanie" disabled={disabled}>
        {(close) => (
          <div className="toolbar-menu toolbar-menu--row">
            {ALIGNMENTS.map((alignment) => (
              <button
                key={alignment.value}
                type="button"
                className="toolbar-btn"
                aria-label={alignment.label}
                onClick={() => { editor?.chain().focus().setTextAlign(alignment.value).run(); close(); }}
              >
                <alignment.Icon size={16} />
              </button>
            ))}
          </div>
        )}
      </ToolbarPopover>

      <ToolbarButton label="Lista punktowana" active={editor?.isActive("bulletList")} disabled={disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16} /></ToolbarButton>
      <ToolbarButton label="Lista numerowana" active={editor?.isActive("orderedList")} disabled={disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></ToolbarButton>
      <ToolbarButton label="Lista zadań" active={editor?.isActive("taskList")} disabled={disabled} onClick={() => editor?.chain().focus().toggleTaskList().run()}><ListChecks size={16} /></ToolbarButton>

      <TableMenu editor={editor} />

      <ToolbarButton label="Cytat" active={editor?.isActive("blockquote")} disabled={disabled} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={16} /></ToolbarButton>
      <ToolbarButton label="Blok kodu" active={editor?.isActive("codeBlock")} disabled={disabled} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}><Code size={16} /></ToolbarButton>
      <ToolbarButton label="Linia pozioma" disabled={disabled} onClick={() => editor?.chain().focus().setHorizontalRule().run()}><Minus size={16} /></ToolbarButton>

      <LinkPopover editor={editor} />
      <ToolbarButton label="Wstaw obraz" disabled={disabled} onClick={onInsertImage}><ImageIcon size={16} /></ToolbarButton>
      <ToolbarButton label="Wyczyść formatowanie" disabled={disabled} onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting size={16} /></ToolbarButton>
    </div>
  );
}
