import type { Editor } from "@tiptap/react";
import { Table as TableIcon, ChevronDown } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";

type TableMenuProps = { editor: Editor | null };

type TableAction = {
  label: string;
  run: (editor: Editor) => void;
  enabled: (editor: Editor) => boolean;
};

const TABLE_ACTIONS: TableAction[] = [
  { label: "Wstaw tabelę 3×3", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), enabled: () => true },
  { label: "Wiersz powyżej", run: (e) => e.chain().focus().addRowBefore().run(), enabled: (e) => Boolean(e.can().addRowBefore()) },
  { label: "Wiersz poniżej", run: (e) => e.chain().focus().addRowAfter().run(), enabled: (e) => Boolean(e.can().addRowAfter()) },
  { label: "Usuń wiersz", run: (e) => e.chain().focus().deleteRow().run(), enabled: (e) => Boolean(e.can().deleteRow()) },
  { label: "Kolumna z lewej", run: (e) => e.chain().focus().addColumnBefore().run(), enabled: (e) => Boolean(e.can().addColumnBefore()) },
  { label: "Kolumna z prawej", run: (e) => e.chain().focus().addColumnAfter().run(), enabled: (e) => Boolean(e.can().addColumnAfter()) },
  { label: "Usuń kolumnę", run: (e) => e.chain().focus().deleteColumn().run(), enabled: (e) => Boolean(e.can().deleteColumn()) },
  { label: "Scal komórki", run: (e) => e.chain().focus().mergeCells().run(), enabled: (e) => Boolean(e.can().mergeCells()) },
  { label: "Podziel komórkę", run: (e) => e.chain().focus().splitCell().run(), enabled: (e) => Boolean(e.can().splitCell()) },
  { label: "Usuń tabelę", run: (e) => e.chain().focus().deleteTable().run(), enabled: (e) => Boolean(e.can().deleteTable()) },
];

export function TableMenu({ editor }: TableMenuProps) {
  return (
    <ToolbarPopover
      trigger={<><TableIcon size={16} /><ChevronDown size={12} /></>}
      label="Tabela"
      disabled={!editor}
    >
      {(close) => (
        <div className="table-menu">
          {TABLE_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              className="table-menu__item"
              disabled={!editor || !action.enabled(editor)}
              onClick={() => {
                if (editor) action.run(editor);
                close();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </ToolbarPopover>
  );
}
