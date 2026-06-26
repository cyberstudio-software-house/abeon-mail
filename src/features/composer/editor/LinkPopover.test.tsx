import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { LinkPopover } from "./LinkPopover";
import { createEditorMock } from "./testSupport";

describe("LinkPopover", () => {
  it("sets a link from the URL field", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<LinkPopover editor={editor} />);
    await user.click(screen.getByLabelText("Wstaw link"));
    await user.type(screen.getByLabelText("URL"), "https://example.com");
    await user.click(screen.getByText("Wstaw"));
    expect(chain.setLink).toHaveBeenCalledWith({ href: "https://example.com" });
  });

  it("inserts an anchor when link text is provided", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<LinkPopover editor={editor} />);
    await user.click(screen.getByLabelText("Wstaw link"));
    await user.type(screen.getByLabelText("URL"), "https://example.com");
    await user.type(screen.getByLabelText("Tekst linku"), "Example");
    await user.click(screen.getByText("Wstaw"));
    expect(chain.insertContent).toHaveBeenCalledWith('<a href="https://example.com">Example</a>');
  });
});
