import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./store";

beforeEach(() => {
  useUiStore.setState({
    selectMode: "thread",
    visibleMessageIds: [1, 2, 3, 4, 5],
    selectedThreadId: 3,
    selectedMessageId: null,
    selectedRowIds: [3],
    selectionAnchorId: 3,
    rowAccounts: {},
  });
});

describe("advanceSelectionAfter", () => {
  it("selects the next thread and opens it in thread mode", () => {
    useUiStore.getState().advanceSelectionAfter([3]);
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([4]);
    expect(s.selectedThreadId).toBe(4);
    expect(s.selectionAnchorId).toBe(4);
  });

  it("selects the next message in message mode without opening a thread", () => {
    useUiStore.setState({ selectMode: "message", selectedThreadId: null, selectedMessageId: 3 });
    useUiStore.getState().advanceSelectionAfter([3]);
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([4]);
    expect(s.selectedMessageId).toBe(4);
    expect(s.selectedThreadId).toBeNull();
    expect(s.selectionAnchorId).toBe(4);
  });

  it("selects the single nearest survivor after a bulk removal", () => {
    useUiStore.setState({ selectedRowIds: [2, 3, 4] });
    useUiStore.getState().advanceSelectionAfter([2, 3, 4]);
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([5]);
    expect(s.selectedThreadId).toBe(5);
  });

  it("clears the selection when no row survives", () => {
    useUiStore.setState({ visibleMessageIds: [1, 2, 3], selectedRowIds: [1, 2, 3] });
    useUiStore.getState().advanceSelectionAfter([1, 2, 3]);
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([]);
    expect(s.selectedThreadId).toBeNull();
    expect(s.selectedMessageId).toBeNull();
    expect(s.selectionAnchorId).toBeNull();
  });
});
