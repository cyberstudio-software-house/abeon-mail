import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mutateSeen = vi.fn();
const mutateArchive = vi.fn();
const mutateDelete = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useSetSeen: () => ({ mutate: mutateSeen }),
  useArchive: () => ({ mutate: mutateArchive }),
  useDelete: () => ({ mutate: mutateDelete }),
}));
vi.mock("../../shared/selection/resolveMessageIds", () => ({
  resolveSelectedMessageIds: vi.fn(async () => [10, 20]),
}));

import { useUiStore } from "../../app/store";
import { BulkActionPanel } from "./BulkActionPanel";

beforeEach(() => {
  mutateSeen.mockClear();
  mutateArchive.mockClear();
  mutateDelete.mockClear();
  useUiStore.setState({
    selectMode: "message",
    visibleMessageIds: [10, 20, 30],
    selectedRowIds: [10, 20],
    selectedThreadId: null,
    selectedMessageId: null,
    rowAccounts: { 10: 1, 20: 1 },
    undoToast: null,
  });
});

describe("BulkActionPanel", () => {
  it("shows count of selected rows", () => {
    render(<BulkActionPanel />);
    expect(screen.getByText(/2/)).toBeTruthy();
  });

  it("mark read resolves ids and calls setSeen(true)", async () => {
    render(<BulkActionPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^mark as read$/i }));
    await waitFor(() => expect(mutateSeen).toHaveBeenCalledWith({ ids: [10, 20], value: true }));
  });

  it("archive resolves ids, calls archive and advances to the next survivor", async () => {
    render(<BulkActionPanel />);
    fireEvent.click(screen.getByRole("button", { name: /archive/i }));
    await waitFor(() => expect(mutateArchive).toHaveBeenCalledWith({ messageIds: [10, 20] }));
    await waitFor(() => expect(useUiStore.getState().selectedMessageId).toBe(30));
  });

  it("disables move-to-folder when selection spans multiple accounts", () => {
    useUiStore.setState({ rowAccounts: { 10: 1, 20: 2 } });
    render(<BulkActionPanel />);
    const moveBtn = screen.getByRole("button", { name: /move to folder/i }) as HTMLButtonElement;
    expect(moveBtn.disabled).toBe(true);
  });
});
