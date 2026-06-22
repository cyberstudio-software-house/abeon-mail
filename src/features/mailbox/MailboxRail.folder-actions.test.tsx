import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { Account, Folder } from "../../ipc/bindings";

const markFolderRead = vi.fn();
const renameFolder = vi.fn();
const deleteFolder = vi.fn();
const createSubfolder = vi.fn();
const togglePin = vi.fn();
const toggleFolderPrefetch = vi.fn();

const accounts: Account[] = [
  { id: 1, email: "a1@x.pl", display_name: "Konto A", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
];

const foldersByAccount = new Map<number, Folder[]>([
  [1, [
    { id: 10, account_id: 1, remote_path: "INBOX", name: "INBOX", folder_type: "inbox", unread_count: 1, total_count: 3 },
    { id: 11, account_id: 1, remote_path: "Klienci", name: "Klienci", folder_type: "custom", unread_count: 0, total_count: 2 },
  ]],
]);

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({ data: accounts, isLoading: false }),
  useFolders: () => ({ data: foldersByAccount.get(1) }),
  useLabels: () => ({ data: [] }),
  useAllAccountFolders: () => foldersByAccount,
  usePinnedMap: () => ({ data: new Map<number, number[]>() }),
  useTogglePinnedFolder: () => ({ mutate: togglePin }),
  usePrefetchFoldersMap: () => ({ data: new Map<number, number[]>() }),
  useToggleFolderPrefetch: () => ({ mutate: toggleFolderPrefetch }),
  useMarkFolderRead: () => ({ mutate: markFolderRead }),
  useRenameFolder: () => ({ mutate: renameFolder }),
  useDeleteFolder: () => ({ mutate: deleteFolder }),
  useCreateSubfolder: () => ({ mutate: createSubfolder }),
  useSyncNow: () => ({ mutate: vi.fn() }),
}));

vi.mock("../../app/store", () => ({ useUiStore: vi.fn() }));

import { useUiStore } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseUiStore = vi.mocked(useUiStore);

function setupStore() {
  mockUseUiStore.mockImplementation((selector: (s: any) => unknown) => {
    const state = {
      selectedAccountId: 1,
      selectedFolderId: null,
      selectedSmartFolder: null,
      selectedLabelId: null,
      searchQuery: "",
      errorToast: null,
      prefetchProgress: {},
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedSmartFolder: vi.fn(),
      setSelectedLabelId: vi.fn(),
      openLabelPicker: vi.fn(),
      openSettings: vi.fn(),
      setSearchQuery: vi.fn(),
      clearSearch: vi.fn(),
      setFocusSearch: vi.fn(),
      showErrorToast: vi.fn(),
      clearErrorToast: vi.fn(),
    };
    return selector ? selector(state) : state;
  });
}

describe("MailboxRail folder actions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows mark-read + new-subfolder for an inbox, no rename/delete", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getAllByText("INBOX")[0]);
    expect(screen.getByRole("menuitem", { name: "Oznacz jako przeczytane" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Nowy podfolder" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Zmień nazwę" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Usuń" })).toBeNull();
  });

  it("marks a custom folder as read from the menu", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Oznacz jako przeczytane" }));
    expect(markFolderRead).toHaveBeenCalledWith(11);
  });

  it("renames a custom folder through the text dialog", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Zmień nazwę" }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Klienci VIP" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameFolder).toHaveBeenCalledWith(
      { folderId: 11, newName: "Klienci VIP" },
      expect.anything(),
    );
  });

  it("deletes a custom folder after confirmation", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Usuń" }));
    fireEvent.click(screen.getByRole("button", { name: "Usuń folder" }));
    expect(deleteFolder).toHaveBeenCalledWith(11, expect.anything());
  });

  it("offers an offline-prefetch toggle that calls the mutation", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pobieraj treść offline" }));
    expect(toggleFolderPrefetch).toHaveBeenCalledWith({ accountId: 1, folderId: 11 });
  });
});
