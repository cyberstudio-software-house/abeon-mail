import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

const archiveMutate = vi.fn();
const deleteMutate = vi.fn();
vi.mock("../../ipc/queries", async (orig) => {
  const actual = await orig<typeof import("../../ipc/queries")>();
  return {
    ...actual,
    useArchive: () => ({ mutate: archiveMutate }),
    useDelete: () => ({ mutate: deleteMutate }),
  };
});

function setup() {
  const qc = new QueryClient();
  qc.setQueryData(["thread-messages", 42], [{ id: 100 }, { id: 101 }]);
  render(
    <QueryClientProvider client={qc}>
      <ShortcutsProvider><div /></ShortcutsProvider>
    </QueryClientProvider>
  );
}

describe("archive/delete shortcuts", () => {
  beforeEach(() => {
    archiveMutate.mockReset();
    deleteMutate.mockReset();
    useUiStore.setState({
      selectMode: "thread",
      visibleMessageIds: [42, 43, 44],
      selectedRowIds: [],
      selectedThreadId: 42,
      selectedMessageId: null,
      undoToast: null,
    });
  });

  it("e archives the whole thread in reader and advances to the next", () => {
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    expect(archiveMutate).toHaveBeenCalledWith({ messageIds: [100, 101] });
    expect(useUiStore.getState().undoToast).toEqual({ kind: "archive", messageIds: [100, 101] });
    expect(useUiStore.getState().selectedThreadId).toBe(43);
  });

  it("# deletes the active selection in list and advances to the next", async () => {
    useUiStore.setState({
      selectMode: "message",
      visibleMessageIds: [6, 7, 8, 9],
      selectedRowIds: [7, 8],
      selectedThreadId: null,
    });
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "#", bubbles: true }));
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith({ messageIds: [7, 8] }));
    expect(useUiStore.getState().undoToast).toEqual({ kind: "delete", messageIds: [7, 8] });
    await waitFor(() => expect(useUiStore.getState().selectedMessageId).toBe(9));
  });
});
