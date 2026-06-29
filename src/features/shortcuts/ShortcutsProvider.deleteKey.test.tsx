import { render } from "@testing-library/react";
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

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("delete key shortcuts", () => {
  beforeEach(() => {
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

  it("Delete deletes the open thread and advances to the next", () => {
    setup();
    pressKey("Delete");
    expect(deleteMutate).toHaveBeenCalledWith({ messageIds: [100, 101] });
    expect(useUiStore.getState().undoToast).toEqual({ kind: "delete", messageIds: [100, 101] });
    expect(useUiStore.getState().selectedThreadId).toBe(43);
  });

  it("Backspace deletes the open thread", () => {
    setup();
    pressKey("Backspace");
    expect(deleteMutate).toHaveBeenCalledWith({ messageIds: [100, 101] });
    expect(useUiStore.getState().selectedThreadId).toBe(43);
  });
});
