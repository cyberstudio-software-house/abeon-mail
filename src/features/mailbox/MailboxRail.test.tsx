import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSetSelectedAccountId = vi.fn();
const mockSetSelectedFolderId = vi.fn();
const mockSetSelectedSmartFolder = vi.fn();
const mockRemoveAccount = vi.fn();
const mockBeginReauth = vi.fn();
const mockReorderAccounts = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useAccounts: vi.fn(),
  useFolders: vi.fn(),
  useRemoveAccount: vi.fn(),
  useBeginReauth: vi.fn(),
  useReorderAccounts: vi.fn(),
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

vi.mock("../accounts/AddAccountWizard", () => ({
  AddAccountWizard: ({ onClose }: { onClose: () => void; onAdded: (id: number) => void }) => (
    <div data-testid="add-account-wizard">
      <button onClick={onClose}>Close wizard</button>
    </div>
  ),
}));

import { useAccounts, useFolders, useRemoveAccount, useBeginReauth, useReorderAccounts } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import type { UiState } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseFolders = vi.mocked(useFolders);
const mockUseRemoveAccount = vi.mocked(useRemoveAccount);
const mockUseBeginReauth = vi.mocked(useBeginReauth);
const mockUseReorderAccounts = vi.mocked(useReorderAccounts);
const mockUseUiStore = vi.mocked(useUiStore);

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

function setupStore(selectedAccountId: number | null = 1, selectedSmartFolder: string | null = null) {
  mockUseUiStore.mockImplementation(
    (selector: (s: UiState) => unknown) => {
      const state: UiState = {
        selectedAccountId,
        selectedFolderId: null,
        selectedMessageId: null,
        selectedThreadId: null,
        selectedSmartFolder: selectedSmartFolder as UiState["selectedSmartFolder"],
        density: "comfortable",
        composer: { open: false, draftId: null, prefill: null },
        setSelectedAccountId: mockSetSelectedAccountId,
        setSelectedFolderId: mockSetSelectedFolderId,
        setSelectedMessageId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setSelectedSmartFolder: mockSetSelectedSmartFolder,
        setDensity: vi.fn(),
        openComposer: vi.fn(),
        closeComposer: vi.fn(),
      };
      return selector ? selector(state) : state;
    }
  );
}

function setupMutations() {
  mockUseRemoveAccount.mockReturnValue({
    mutate: mockRemoveAccount,
    isPending: false,
  } as unknown as ReturnType<typeof useRemoveAccount>);

  mockUseBeginReauth.mockReturnValue({
    mutate: mockBeginReauth,
    isPending: false,
  } as unknown as ReturnType<typeof useBeginReauth>);

  mockUseReorderAccounts.mockReturnValue({
    mutate: mockReorderAccounts,
    isPending: false,
  } as unknown as ReturnType<typeof useReorderAccounts>);

  mockUseFolders.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useFolders>);
}

describe("MailboxRail", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders 3 enabled smart folders (no Snoozed or Drafts)", () => {
    setupStore(null);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    expect(screen.getByText("All Inboxes")).toBeTruthy();
    expect(screen.getByText("Unread")).toBeTruthy();
    expect(screen.getByText("Flagged")).toBeTruthy();
    expect(screen.queryByText("Snoozed")).toBeNull();
    expect(screen.queryByText("Drafts")).toBeNull();

    const allInboxesEl = screen.getByText("All Inboxes");
    expect(allInboxesEl.closest("[aria-disabled]")).toBeNull();
  });

  it("clicking All Inboxes calls setSelectedSmartFolder('all_inboxes')", async () => {
    const user = userEvent.setup();
    setupStore(null);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);
    await user.click(screen.getByText("All Inboxes"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("all_inboxes");
  });

  it("clicking Unread calls setSelectedSmartFolder('unread')", async () => {
    const user = userEvent.setup();
    setupStore(null);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);
    await user.click(screen.getByText("Unread"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("unread");
  });

  it("clicking Flagged calls setSelectedSmartFolder('flagged')", async () => {
    const user = userEvent.setup();
    setupStore(null);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);
    await user.click(screen.getByText("Flagged"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("flagged");
  });

  it("renders account and folder, clicking folder calls setSelectedFolderId", async () => {
    const user = userEvent.setup();
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [singleAccount],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [singleFolder],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("Inbox")).toBeTruthy();
    await user.click(screen.getByText("Inbox"));
    expect(mockSetSelectedFolderId).toHaveBeenCalledWith(10);
  });

  it("renders empty state when no accounts", () => {
    setupStore(null);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);
    expect(screen.getByText(/no accounts/i)).toBeTruthy();
  });

  it("shows reauth badge when account.requires_reauth is true", () => {
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    expect(screen.getByText("⚠ Reconnect")).toBeTruthy();
  });

  it("clicking Reconnect badge calls beginReauth with account id", async () => {
    const user = userEvent.setup();
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    await user.click(screen.getByText("⚠ Reconnect"));

    expect(mockBeginReauth).toHaveBeenCalledWith(1);
  });

  it("no reauth badge when account.requires_reauth is false", () => {
    setupStore(2);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountNormal],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    expect(screen.queryByText("⚠ Reconnect")).toBeNull();
  });

  it("shows confirm dialog when remove button clicked, calls removeAccount on confirm", async () => {
    const user = userEvent.setup();
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    await user.click(screen.getByRole("button", { name: /remove account a/i }));

    expect(screen.getByText(/permanently remove/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /confirm/i }));

    expect(mockRemoveAccount).toHaveBeenCalledWith(1);
  });

  it("cancelling remove dialog does not call removeAccount", async () => {
    const user = userEvent.setup();
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    await user.click(screen.getByRole("button", { name: /remove account a/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockRemoveAccount).not.toHaveBeenCalled();
  });
});
