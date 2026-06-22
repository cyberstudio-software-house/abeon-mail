import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Account, Folder } from "../../ipc/bindings";

const mutate = vi.fn();

const accounts: Account[] = [
  { id: 1, email: "a1@x.pl", display_name: "Konto A", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
  { id: 2, email: "a2@x.pl", display_name: "Konto B", provider_type: "imap_password", color: null, position: 2, requires_reauth: false },
];

const foldersByAccount = new Map<number, Folder[]>([
  [1, [
    { id: 10, account_id: 1, remote_path: "INBOX", name: "INBOX", folder_type: "inbox", unread_count: 3, total_count: 9 },
    { id: 11, account_id: 1, remote_path: "Klienci", name: "Klienci", folder_type: "custom", unread_count: 0, total_count: 2 },
  ]],
  [2, [
    { id: 20, account_id: 2, remote_path: "INBOX", name: "INBOX", folder_type: "inbox", unread_count: 0, total_count: 4 },
  ]],
]);

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({ data: accounts, isLoading: false }),
  useFolders: () => ({ data: foldersByAccount.get(1) }),
  useLabels: () => ({ data: [] }),
  useAllAccountFolders: () => foldersByAccount,
  usePinnedMap: () => ({ data: new Map<number, number[]>([[1, [11]]]) }),
  useTogglePinnedFolder: () => ({ mutate }),
  usePrefetchFoldersMap: () => ({ data: new Map<number, number[]>() }),
  useToggleFolderPrefetch: () => ({ mutate: vi.fn() }),
  useMarkFolderRead: () => ({ mutate: vi.fn() }),
  useRenameFolder: () => ({ mutate: vi.fn() }),
  useDeleteFolder: () => ({ mutate: vi.fn() }),
  useCreateSubfolder: () => ({ mutate: vi.fn() }),
  useSyncNow: () => ({ mutate: vi.fn() }),
}));

vi.mock("../../app/store", () => ({ useUiStore: vi.fn() }));

import { useUiStore } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseUiStore = vi.mocked(useUiStore);

function setupStore() {
  mockUseUiStore.mockImplementation((selector: (s: any) => unknown) => {
    const state = {
      selectedAccountId: null,
      selectedFolderId: null,
      selectedSmartFolder: null,
      selectedLabelId: null,
      smartFoldersEnabled: true,
      smartFolderVisibility: { all_inboxes: true, unread: true, flagged: true, snoozed: true },
      searchQuery: "",
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
    };
    return selector ? selector(state) : state;
  });
}

describe("MailboxRail pinned + inbox sections", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders an INBOX row per account", () => {
    setupStore();
    render(<MailboxRail />);
    const inboxHeader = screen.getByText("Inbox");
    expect(inboxHeader).toBeTruthy();
    expect(screen.getAllByText("Konto A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Konto B").length).toBeGreaterThan(0);
  });

  it("renders pinned folders grouped under their account", () => {
    setupStore();
    render(<MailboxRail />);
    expect(screen.getByText("Klienci")).toBeTruthy();
  });

  it("toggles a pin from the folder context menu", () => {
    setupStore();
    render(<MailboxRail />);
    fireEvent.contextMenu(screen.getByText("Klienci"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Odepnij" }));
    expect(mutate).toHaveBeenCalledWith({ accountId: 1, folderId: 11 });
  });
});
