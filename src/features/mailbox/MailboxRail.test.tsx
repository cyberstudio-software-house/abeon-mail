import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSetSelectedAccountId = vi.fn();
const mockSetSelectedFolderId = vi.fn();
const mockSetSelectedSmartFolder = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useAccounts: vi.fn(),
  useFolders: vi.fn(),
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

import { useAccounts, useFolders } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import type { UiState } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseFolders = vi.mocked(useFolders);
const mockUseUiStore = vi.mocked(useUiStore);

const singleAccount = {
  id: 1,
  email: "a@x.com",
  display_name: "A",
  color: "#4f46e5",
  position: 0,
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

describe("MailboxRail", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders 3 enabled smart folders (no Snoozed or Drafts)", () => {
    setupStore(null);
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

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
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    await user.click(screen.getByText("All Inboxes"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("all_inboxes");
  });

  it("clicking Unread calls setSelectedSmartFolder('unread')", async () => {
    const user = userEvent.setup();
    setupStore(null);
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    await user.click(screen.getByText("Unread"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("unread");
  });

  it("clicking Flagged calls setSelectedSmartFolder('flagged')", async () => {
    const user = userEvent.setup();
    setupStore(null);
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    await user.click(screen.getByText("Flagged"));
    expect(mockSetSelectedSmartFolder).toHaveBeenCalledWith("flagged");
  });

  it("renders account and folder, clicking folder calls setSelectedFolderId", async () => {
    const user = userEvent.setup();
    setupStore(1);
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
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);
    mockUseFolders.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useFolders>);

    render(<MailboxRail />);
    expect(screen.getByText(/no accounts/i)).toBeTruthy();
  });
});
