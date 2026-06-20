import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RailContextMenu } from "./RailContextMenu";

describe("RailContextMenu", () => {
  afterEach(() => cleanup());

  it("renders the provided items", () => {
    render(
      <RailContextMenu x={10} y={20} onClose={vi.fn()} items={[{ label: "Przypnij", onClick: vi.fn() }]} />,
    );
    expect(screen.getByRole("menuitem", { name: "Przypnij" })).toBeTruthy();
  });

  it("fires onClick and onClose when an item is chosen", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(
      <RailContextMenu x={0} y={0} onClose={onClose} items={[{ label: "Odepnij", onClick }]} />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Odepnij" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <RailContextMenu x={0} y={0} onClose={onClose} items={[{ label: "Przypnij", onClick: vi.fn() }]} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
