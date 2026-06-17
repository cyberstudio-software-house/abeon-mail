import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSetSelectedAccountId = vi.fn();
const mockSetSelectedFolderId = vi.fn();

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
import { MailboxRail } from "./MailboxRail";

type UiState = {
  selectedAccountId: number | null;
  selectedFolderId: number | null;
  selectedMessageId: number | null;
  density: "comfortable" | "cozy" | "compact" | "dense";
  setSelectedAccountId: (id: number | null) => void;
  setSelectedFolderId: (id: number | null) => void;
  setSelectedMessageId: (id: number | null) => void;
  setDensity: (density: "comfortable" | "cozy" | "compact" | "dense") => void;
};

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseFolders = vi.mocked(useFolders);
const mockUseUiStore = vi.mocked(useUiStore);

const singleAccount = {
  id: 1,
  email: "a@x.com",
  display_name: "A",
  color: "#4f46e5",
  position: 0,
};

const singleFolder = {
  id: 10,
  account_id: 1,
  name: "Inbox",
  folder_type: "inbox",
  unread_count: 2,
  total_count: 5,
  remote_path: "INBOX",
  uidvalidity: 1,
  uidnext: 1,
  sync_state: "idle",
};

function setupStore(selectedAccountId: number | null = 1) {
  mockUseUiStore.mockImplementation(
    (selector: (s: UiState) => unknown) => {
      const state: UiState = {
        selectedAccountId,
        selectedFolderId: null,
        selectedMessageId: null,
        density: "comfortable",
        setSelectedAccountId: mockSetSelectedAccountId,
        setSelectedFolderId: mockSetSelectedFolderId,
        setSelectedMessageId: vi.fn(),
        setDensity: vi.fn(),
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
