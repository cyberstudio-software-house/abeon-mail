import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

const undoMutate = vi.fn();
vi.mock("../../ipc/queries", async (orig) => {
  const actual = await orig<typeof import("../../ipc/queries")>();
  return {
    ...actual,
    useUndoMove: () => ({ mutate: undoMutate }),
  };
});

function setup() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ShortcutsProvider><div /></ShortcutsProvider>
    </QueryClientProvider>
  );
}

function pressUndo() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
}

describe("undo shortcut", () => {
  beforeEach(() => {
    undoMutate.mockReset();
    useUiStore.setState({
      selectedThreadId: 42,
      undoToast: { kind: "archive", messageIds: [100, 101] },
    });
    useUiStore.setState((s) => ({ composer: { ...s.composer, open: false } }));
  });

  it("Ctrl+Z undoes the pending toast and clears it in the reader", async () => {
    setup();
    pressUndo();
    await waitFor(() => expect(undoMutate).toHaveBeenCalledWith({ messageIds: [100, 101] }));
    expect(useUiStore.getState().undoToast).toBeNull();
  });

  it("does nothing when there is no pending toast", () => {
    useUiStore.setState({ undoToast: null });
    setup();
    pressUndo();
    expect(undoMutate).not.toHaveBeenCalled();
  });

  it("stays inactive in the composer so native text undo works", () => {
    useUiStore.setState((s) => ({ composer: { ...s.composer, open: true } }));
    setup();
    pressUndo();
    expect(undoMutate).not.toHaveBeenCalled();
    expect(useUiStore.getState().undoToast).toEqual({ kind: "archive", messageIds: [100, 101] });
  });
});
