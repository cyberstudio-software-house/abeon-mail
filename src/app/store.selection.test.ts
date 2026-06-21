import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./store";

beforeEach(() => {
  useUiStore.setState({
    selectMode: "thread",
    visibleMessageIds: [1, 2, 3, 4, 5],
    selectedThreadId: null,
    selectedMessageId: null,
    selectedRowIds: [],
    selectionAnchorId: null,
    rowAccounts: {},
  });
});

describe("selection model", () => {
  it("selectRow selects one row, sets anchor and opens thread", () => {
    useUiStore.getState().selectRow(3);
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([3]);
    expect(s.selectionAnchorId).toBe(3);
    expect(s.selectedThreadId).toBe(3);
  });

  it("toggleRow adds and removes rows", () => {
    useUiStore.getState().selectRow(2);
    useUiStore.getState().toggleRow(4);
    expect(useUiStore.getState().selectedRowIds).toEqual([2, 4]);
    useUiStore.getState().toggleRow(2);
    expect(useUiStore.getState().selectedRowIds).toEqual([4]);
  });

  it("toggleRow down to one reopens that row", () => {
    useUiStore.setState({ selectedRowIds: [2, 4], selectedThreadId: 2 });
    useUiStore.getState().toggleRow(2);
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([4]);
    expect(s.selectedThreadId).toBe(4);
  });

  it("selectRangeTo selects inclusive range from anchor", () => {
    useUiStore.getState().selectRow(2);
    useUiStore.getState().selectRangeTo(4);
    expect(useUiStore.getState().selectedRowIds).toEqual([2, 3, 4]);
  });

  it("selectRangeTo works upward (clicked before anchor)", () => {
    useUiStore.getState().selectRow(4);
    useUiStore.getState().selectRangeTo(2);
    expect(useUiStore.getState().selectedRowIds).toEqual([2, 3, 4]);
  });

  it("clearSelection empties selection and anchor", () => {
    useUiStore.getState().selectRow(2);
    useUiStore.getState().clearSelection();
    const s = useUiStore.getState();
    expect(s.selectedRowIds).toEqual([]);
    expect(s.selectionAnchorId).toBeNull();
  });

  it("setListContext stores rowAccounts", () => {
    useUiStore.getState().setListContext([1, 2], "message", { 1: 10, 2: 20 });
    expect(useUiStore.getState().rowAccounts).toEqual({ 1: 10, 2: 20 });
  });
});

describe("folder picker state", () => {
  it("openFolderPicker sets target and account; close resets", () => {
    useUiStore.getState().openFolderPicker([3, 4], 9);
    let s = useUiStore.getState();
    expect(s.folderPickerOpen).toBe(true);
    expect(s.folderPickerTargetIds).toEqual([3, 4]);
    expect(s.folderPickerAccountId).toBe(9);
    useUiStore.getState().closeFolderPicker();
    s = useUiStore.getState();
    expect(s.folderPickerOpen).toBe(false);
    expect(s.folderPickerTargetIds).toEqual([]);
    expect(s.folderPickerAccountId).toBeNull();
  });
});
