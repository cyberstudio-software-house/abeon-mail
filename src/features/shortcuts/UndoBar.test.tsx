import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UndoBar } from "./UndoBar";
import { useUiStore } from "../../app/store";

const mockUndo = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useUndoMove: () => ({ mutate: mockUndo }),
}));

describe("UndoBar", () => {
  beforeEach(() => {
    mockUndo.mockReset();
    useUiStore.setState({ undoToast: null });
  });

  it("renders nothing when no toast", () => {
    const { container } = render(<UndoBar />);
    expect(container.firstChild).toBeNull();
  });

  it("shows label and calls undo on click", () => {
    useUiStore.setState({ undoToast: { kind: "archive", messageIds: [1, 2] } });
    render(<UndoBar />);
    expect(screen.getByText(/Archived/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(mockUndo).toHaveBeenCalledWith({ messageIds: [1, 2] });
    expect(useUiStore.getState().undoToast).toBeNull();
  });
});
