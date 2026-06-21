import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TextInputDialog, ConfirmDialog } from "./RailDialogs";

describe("RailDialogs", () => {
  afterEach(() => cleanup());

  it("TextInputDialog confirms the typed value on Enter", () => {
    const onConfirm = vi.fn();
    render(<TextInputDialog title="Nowy podfolder" onConfirm={onConfirm} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Projekty" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("Projekty");
  });

  it("TextInputDialog prefills initialValue and cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<TextInputDialog title="Zmień nazwę" initialValue="Stara" onConfirm={vi.fn()} onCancel={onCancel} />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Stara");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("TextInputDialog does not confirm an empty value", () => {
    const onConfirm = vi.fn();
    render(<TextInputDialog title="Nowy podfolder" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ConfirmDialog fires onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Usuń folder" message="Na pewno?" confirmLabel="Usuń" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Usuń" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("ConfirmDialog cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Usuń folder" message="Na pewno?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
