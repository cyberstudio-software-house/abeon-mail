import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { EditorToolbar } from "./EditorToolbar";
import { createEditorMock } from "./testSupport";

describe("EditorToolbar", () => {
  it("does not crash and disables buttons when editor is null", () => {
    render(<EditorToolbar editor={null} onInsertImage={() => {}} />);
    expect((screen.getByLabelText("Pogrubienie") as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggles bold", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<EditorToolbar editor={editor} onInsertImage={() => {}} />);
    await user.click(screen.getByLabelText("Pogrubienie"));
    expect(chain.toggleBold).toHaveBeenCalled();
  });

  it("applies a named font size preset", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<EditorToolbar editor={editor} onInsertImage={() => {}} />);
    await user.click(screen.getByLabelText("Rozmiar czcionki"));
    await user.click(screen.getByText("Duży"));
    expect(chain.setFontSize).toHaveBeenCalledWith("18px");
  });

  it("calls onInsertImage", async () => {
    const user = userEvent.setup();
    const { editor } = createEditorMock();
    const onInsertImage = vi.fn();
    render(<EditorToolbar editor={editor} onInsertImage={onInsertImage} />);
    await user.click(screen.getByLabelText("Wstaw obraz"));
    expect(onInsertImage).toHaveBeenCalled();
  });
});
