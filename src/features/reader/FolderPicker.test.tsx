import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockMutate = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useFolders: () => ({
    data: [
      { id: 1, account_id: 9, name: "Work", folder_type: "custom", remote_path: "Work", unread_count: 0, total_count: 0 },
      { id: 2, account_id: 9, name: "Drafts", folder_type: "drafts", remote_path: "Drafts", unread_count: 0, total_count: 0 },
    ],
  }),
  useMoveToFolder: () => ({ mutate: mockMutate }),
}));

import { useUiStore } from "../../app/store";
import { FolderPicker } from "./FolderPicker";

beforeEach(() => {
  mockMutate.mockClear();
  useUiStore.setState({
    folderPickerOpen: true,
    folderPickerTargetIds: [10, 20],
    folderPickerAccountId: 9,
  });
});

describe("FolderPicker", () => {
  it("lists movable folders and hides drafts/sent/trash", () => {
    render(<FolderPicker />);
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.queryByText("Drafts")).toBeNull();
  });

  it("moving calls useMoveToFolder with target ids and folder id", () => {
    render(<FolderPicker />);
    fireEvent.click(screen.getByText("Work"));
    expect(mockMutate).toHaveBeenCalledWith({ messageIds: [10, 20], targetFolderId: 1 });
  });
});
