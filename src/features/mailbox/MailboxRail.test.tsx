import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../ipc/queries", () => ({
  useAccounts: vi.fn(),
  useFolders: vi.fn(),
  useLabels: () => ({ data: [{ id: 1, name: "Work", color: "#4f46e5" }] }),
  useAllAccountFolders: () => new Map(),
  usePinnedMap: () => ({ data: new Map() }),
  useTogglePinnedFolder: () => ({ mutate: vi.fn() }),
  usePrefetchFoldersMap: () => ({ data: new Map() }),
  useToggleFolderPrefetch: () => ({ mutate: vi.fn() }),
  useMarkFolderRead: () => ({ mutate: vi.fn() }),
  useRenameFolder: () => ({ mutate: vi.fn() }),
  useDeleteFolder: () => ({ mutate: vi.fn() }),
  useCreateSubfolder: () => ({ mutate: vi.fn() }),
  useSyncNow: () => ({ mutate: vi.fn() }),
}));

vi.mock("../../app/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/store")>();
  return actual;
});

import { useAccounts, useFolders } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseFolders = vi.mocked(useFolders);

const accountWithReauth = {
  id: 1,
  email: "a@x.com",
  display_name: "A",
  color: "#4f46e5",
  position: 0,
  requires_reauth: true,
  provider_type: "google_oauth" as const,
};

const accountNormal = {
  id: 2,
  email: "b@x.com",
  display_name: "B",
  color: "#10b981",
  position: 1,
  requires_reauth: false,
  provider_type: "imap_password" as const,
};

const singleAccount = {
  id: 1,
  email: "a@x.com",
  display_name: "A",
  color: "#4f46e5",
  position: 0,
  requires_reauth: false,
  provider_type: "imap_password" as const,
};

const singleFolder = {
  id: 10,
  account_id: 1,
  name: "Inbox",
  folder_type: "inbox" as const,
  unread_count: 2,
  total_count: 5,
  remote_path: "INBOX",
};

function folder(id: number, name: string, folder_type: string) {
  return {
    id,
    account_id: 1,
    name,
    folder_type,
    unread_count: 0,
    total_count: 0,
    remote_path: name,
  };
}

function accounts(data: unknown[]) {
  mockUseAccounts.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useAccounts>);
}

function folders(data: unknown[]) {
  mockUseFolders.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useFolders>);
}

function setupStore(selectedAccountId: number | null = 1) {
  useUiStore.setState({
    selectedAccountId,
    selectedFolderId: null,
    selectedSmartFolder: null,
    selectedLabelId: null,
    searchQuery: "",
    searchActive: false,
    focusSearch: null,
    smartFoldersEnabled: true,
    smartFolderVisibility: { all_inboxes: true, unread: true, flagged: true, snoozed: true },
  });
}

describe("MailboxRail", () => {
  beforeEach(() => {
    setupStore(null);
    folders([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders 4 smart folders (no Drafts)", () => {
    accounts([]);
    render(<MailboxRail />);
    expect(screen.getByText("All Inboxes")).toBeTruthy();
    expect(screen.getByText("Unread")).toBeTruthy();
    expect(screen.getByText("Flagged")).toBeTruthy();
    expect(screen.getByText("Snoozed")).toBeTruthy();
    expect(screen.queryByText("Drafts")).toBeNull();
  });

  it("hides a smart folder turned off in visibility, keeps the rest", () => {
    accounts([]);
    useUiStore.setState({
      smartFolderVisibility: { all_inboxes: true, unread: true, flagged: false, snoozed: true },
    });
    render(<MailboxRail />);
    expect(screen.queryByText("Flagged")).toBeNull();
    expect(screen.getByText("All Inboxes")).toBeTruthy();
    expect(screen.getByText("Unread")).toBeTruthy();
    expect(screen.getByText("Snoozed")).toBeTruthy();
  });

  it("hides the whole Smart Folders section when the master toggle is off", () => {
    accounts([]);
    useUiStore.setState({ smartFoldersEnabled: false });
    render(<MailboxRail />);
    expect(screen.queryByText("Smart Folders")).toBeNull();
    expect(screen.queryByText("All Inboxes")).toBeNull();
    expect(screen.queryByText("Unread")).toBeNull();
    expect(screen.queryByText("Flagged")).toBeNull();
    expect(screen.queryByText("Snoozed")).toBeNull();
  });

  it("hides the section when every smart folder is turned off", () => {
    accounts([]);
    useUiStore.setState({
      smartFolderVisibility: { all_inboxes: false, unread: false, flagged: false, snoozed: false },
    });
    render(<MailboxRail />);
    expect(screen.queryByText("Smart Folders")).toBeNull();
  });

  it("clicking a smart folder selects it", async () => {
    const user = userEvent.setup();
    accounts([]);
    render(<MailboxRail />);
    await user.click(screen.getByText("All Inboxes"));
    expect(useUiStore.getState().selectedSmartFolder).toBe("all_inboxes");
    await user.click(screen.getByText("Unread"));
    expect(useUiStore.getState().selectedSmartFolder).toBe("unread");
    await user.click(screen.getByText("Flagged"));
    expect(useUiStore.getState().selectedSmartFolder).toBe("flagged");
    await user.click(screen.getByText("Snoozed"));
    expect(useUiStore.getState().selectedSmartFolder).toBe("snoozed");
  });

  it("shows search input and live labels, no 'Coming soon'", () => {
    accounts([]);
    render(<MailboxRail />);
    expect(screen.getByLabelText("Search mail")).toBeTruthy();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(screen.getByText("Work")).toBeTruthy();
  });

  it("footer has only the settings button — no Add account button", () => {
    accounts([]);
    render(<MailboxRail />);
    expect(screen.getByRole("button", { name: /open settings/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add account/i })).toBeNull();
  });

  it("does not render the IPC status line", () => {
    accounts([]);
    render(<MailboxRail />);
    expect(screen.queryByText(/^IPC:/)).toBeNull();
  });

  it("Open settings button calls openSettings", async () => {
    const user = userEvent.setup();
    accounts([]);
    const openSettingsSpy = vi.spyOn(useUiStore.getState(), "openSettings");
    render(<MailboxRail />);
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    expect(openSettingsSpy).toHaveBeenCalled();
    openSettingsSpy.mockRestore();
  });

  it("renders account and folder, clicking folder selects it", async () => {
    const user = userEvent.setup();
    setupStore(1);
    accounts([singleAccount]);
    folders([singleFolder]);
    render(<MailboxRail />);
    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
    expect(screen.getByText("Inbox")).toBeTruthy();
    await user.click(screen.getByText("Inbox"));
    expect(useUiStore.getState().selectedFolderId).toBe(10);
  });

  it("collapses and re-expands the selected account's folders on click", async () => {
    const user = userEvent.setup();
    setupStore(1);
    accounts([singleAccount]);
    folders([singleFolder]);
    render(<MailboxRail />);
    const nameLabel = () =>
      screen.getAllByText("A").find((el) => el.className.includes("rail__item-label"))!;
    expect(screen.getByText("Inbox")).toBeTruthy();
    await user.click(nameLabel());
    expect(screen.queryByText("Inbox")).toBeNull();
    await user.click(nameLabel());
    expect(screen.getByText("Inbox")).toBeTruthy();
  });

  it("renders key folders on top, then the rest alphabetically", () => {
    setupStore(1);
    accounts([singleAccount]);
    folders([
      folder(30, "Zebra", "custom"),
      folder(31, "Alpha", "custom"),
      folder(32, "INBOX", "inbox"),
    ]);
    render(<MailboxRail />);
    const inbox = screen.getByText("INBOX");
    const alpha = screen.getByText("Alpha");
    const zebra = screen.getByText("Zebra");
    expect(inbox.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alpha.compareDocumentPosition(zebra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders empty state when no accounts", () => {
    accounts([]);
    render(<MailboxRail />);
    expect(screen.getByText(/no accounts/i)).toBeTruthy();
  });

  it("shows a non-interactive reauth indicator when requires_reauth is true", () => {
    setupStore(1);
    accounts([accountWithReauth]);
    render(<MailboxRail />);
    const badge = screen.getByLabelText(/needs reconnect/i);
    expect(badge).toBeTruthy();
    expect(badge.tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
  });

  it("no reauth indicator when requires_reauth is false", () => {
    setupStore(2);
    accounts([accountNormal]);
    render(<MailboxRail />);
    expect(screen.queryByLabelText(/needs reconnect/i)).toBeNull();
  });

  it("does not render account management controls (remove)", () => {
    setupStore(1);
    accounts([singleAccount]);
    render(<MailboxRail />);
    expect(screen.queryByRole("button", { name: /remove account/i })).toBeNull();
  });

  it("clicking an account selects it", async () => {
    const user = userEvent.setup();
    setupStore(null);
    accounts([accountNormal]);
    render(<MailboxRail />);
    const nameLabel = screen
      .getAllByText("B")
      .find((el) => el.className.includes("rail__item-label"));
    await user.click(nameLabel!);
    expect(useUiStore.getState().selectedAccountId).toBe(2);
  });

  it("typing in the search input updates the store and clears via the clear button", async () => {
    const user = userEvent.setup();
    accounts([]);
    render(<MailboxRail />);
    const input = screen.getByLabelText("Search mail");
    await user.type(input, "report");
    expect(useUiStore.getState().searchQuery).toBe("report");
    expect(useUiStore.getState().searchActive).toBe(true);
    await user.click(screen.getByLabelText("Clear search"));
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().searchActive).toBe(false);
  });

  it("renders labels and selects one on click", async () => {
    accounts([]);
    render(<MailboxRail />);
    const chip = await screen.findByText("Work");
    fireEvent.click(chip);
    expect(useUiStore.getState().selectedLabelId).toBe(1);
  });
});
