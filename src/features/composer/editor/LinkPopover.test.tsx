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

  it("inserts a link mark via structured content when text is provided", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<LinkPopover editor={editor} />);
    await user.click(screen.getByLabelText("Wstaw link"));
    await user.type(screen.getByLabelText("URL"), "https://example.com");
    await user.type(screen.getByLabelText("Tekst linku"), "Example");
    await user.click(screen.getByText("Wstaw"));
    expect(chain.insertContent).toHaveBeenCalledWith({
      type: "text",
      text: "Example",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });
  });

  it("rejects a javascript: URL", async () => {
    const user = userEvent.setup();
    const { editor, chain } = createEditorMock();
    render(<LinkPopover editor={editor} />);
    await user.click(screen.getByLabelText("Wstaw link"));
    await user.type(screen.getByLabelText("URL"), "javascript:alert(1)");
    await user.type(screen.getByLabelText("Tekst linku"), "x");
    await user.click(screen.getByText("Wstaw"));
    expect(chain.insertContent).not.toHaveBeenCalled();
    expect(chain.setLink).not.toHaveBeenCalled();
  });
});
