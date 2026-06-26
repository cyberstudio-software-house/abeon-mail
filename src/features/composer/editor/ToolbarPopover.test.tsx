import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { ToolbarPopover } from "./ToolbarPopover";

describe("ToolbarPopover", () => {
  it("toggles the panel on trigger click", async () => {
    const user = userEvent.setup();
    render(
      <ToolbarPopover trigger="T" label="Test">
        {() => <div>panel-content</div>}
      </ToolbarPopover>,
    );
    expect(screen.queryByText("panel-content")).toBeNull();
    await user.click(screen.getByLabelText("Test"));
    expect(screen.getByText("panel-content")).toBeTruthy();
  });

  it("closes when the provided close fn runs", async () => {
    const user = userEvent.setup();
    render(
      <ToolbarPopover trigger="T" label="Test">
        {(close) => <button onClick={close}>do</button>}
      </ToolbarPopover>,
    );
    await user.click(screen.getByLabelText("Test"));
    await user.click(screen.getByText("do"));
    expect(screen.queryByText("do")).toBeNull();
  });
});
