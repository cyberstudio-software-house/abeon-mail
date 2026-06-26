import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ColorSwatchGrid } from "./ColorSwatchGrid";

describe("ColorSwatchGrid", () => {
  it("calls onPick with the swatch color", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<ColorSwatchGrid onPick={onPick} onReset={() => {}} />);
    await user.click(screen.getByLabelText("Kolor #ff0000"));
    expect(onPick).toHaveBeenCalledWith("#ff0000");
  });

  it("calls onReset from the default button", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(<ColorSwatchGrid onPick={() => {}} onReset={onReset} />);
    await user.click(screen.getByText("Domyślny"));
    expect(onReset).toHaveBeenCalled();
  });
});
