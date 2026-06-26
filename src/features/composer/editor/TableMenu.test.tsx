import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { TableMenu } from "./TableMenu";
import { createEditorMock } from "./testSupport";

describe("TableMenu", () => {
  it("inserts a 3x3 table with header row", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<TableMenu editor={editor} />);
    await user.click(screen.getByLabelText("Tabela"));
    await user.click(screen.getByText("Wstaw tabelę 3×3"));
    expect(chain.insertTable).toHaveBeenCalledWith({ rows: 3, cols: 3, withHeaderRow: true });
  });

  it("deletes the current row", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<TableMenu editor={editor} />);
    await user.click(screen.getByLabelText("Tabela"));
    await user.click(screen.getByText("Usuń wiersz"));
    expect(chain.deleteRow).toHaveBeenCalled();
  });
});
