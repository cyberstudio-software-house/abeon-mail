import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./store";

beforeEach(() => {
  useUiStore.setState({
    selectedAccountId: null,
    selectedFolderId: null,
    selectedMessageId: null,
    selectedThreadId: null,
    selectedSmartFolder: null,
    density: "comfortable",
    composer: { open: false, draftId: null, prefill: null },
  });
});

describe("selectedSmartFolder mutual exclusion", () => {
  it("setSelectedSmartFolder clears account, folder, and thread selection", () => {
    useUiStore.setState({
      selectedAccountId: 1,
      selectedFolderId: 10,
      selectedThreadId: 5,
    });

    useUiStore.getState().setSelectedSmartFolder("all_inboxes");

    const s = useUiStore.getState();
    expect(s.selectedSmartFolder).toBe("all_inboxes");
    expect(s.selectedAccountId).toBeNull();
    expect(s.selectedFolderId).toBeNull();
    expect(s.selectedThreadId).toBeNull();
  });

  it("setSelectedSmartFolder(null) clears smart folder", () => {
    useUiStore.setState({ selectedSmartFolder: "unread" });
    useUiStore.getState().setSelectedSmartFolder(null);
    expect(useUiStore.getState().selectedSmartFolder).toBeNull();
  });

  it("setSelectedAccountId clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "flagged" });
    useUiStore.getState().setSelectedAccountId(2);
    const s = useUiStore.getState();
    expect(s.selectedAccountId).toBe(2);
    expect(s.selectedSmartFolder).toBeNull();
  });

  it("setSelectedFolderId clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "unread" });
    useUiStore.getState().setSelectedFolderId(7);
    const s = useUiStore.getState();
    expect(s.selectedFolderId).toBe(7);
    expect(s.selectedSmartFolder).toBeNull();
  });

  it("setSelectedAccountId(null) clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "all_inboxes" });
    useUiStore.getState().setSelectedAccountId(null);
    expect(useUiStore.getState().selectedSmartFolder).toBeNull();
  });
});
