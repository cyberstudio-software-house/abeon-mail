import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let capturedOnDragEnd: ((event: { active: { id: unknown }; over: { id: unknown } | null }) => void) | null = null;

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (event: { active: { id: unknown }; over: { id: unknown } | null }) => void }) => {
      capturedOnDragEnd = onDragEnd;
      return <div>{children}</div>;
    },
  };
});

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

vi.mock("../../app/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/store")>();
  return actual;
});

vi.mock("../accounts/AddAccountWizard", () => ({
  AddAccountWizard: ({ onClose }: { onClose: () => void; onAdded: (id: number) => void }) => (
    <div data-testid="add-account-wizard">
      <button onClick={onClose}>Close wizard</button>
    </div>
  ),
}));

import { useAccounts, useFolders, useRemoveAccount, useBeginReauth, useReorderAccounts } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { MailboxRail } from "./MailboxRail";

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseFolders = vi.mocked(useFolders);
const mockUseRemoveAccount = vi.mocked(useRemoveAccount);
const mockUseBeginReauth = vi.mocked(useBeginReauth);
const mockUseReorderAccounts = vi.mocked(useReorderAccounts);

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
  useUiStore.setState({
    selectedAccountId,
    selectedFolderId: null,
    selectedSmartFolder: selectedSmartFolder as ReturnType<typeof useUiStore.getState>["selectedSmartFolder"],
    searchQuery: "",
    searchActive: false,
    focusSearch: null,
  });
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
  beforeEach(() => {
    useUiStore.setState({
      selectedAccountId: null,
      selectedFolderId: null,
      selectedSmartFolder: null,
      searchQuery: "",
      searchActive: false,
      focusSearch: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    capturedOnDragEnd = null;
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
    expect(screen.queryByText("Drafts")).toBeNull();

    const allInboxesEl = screen.getByText("All Inboxes");
    expect(allInboxesEl.closest("[aria-disabled]")).toBeNull();
  });

  it("smart folders remain clickable and select the smart folder", async () => {
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
    expect(useUiStore.getState().selectedSmartFolder).toBe("all_inboxes");
  });

  it("Snoozed and LABELS are non-interactive placeholders; search is now a real input", () => {
    setupStore(null);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    expect(screen.getByLabelText("Search mail")).toBeTruthy();

    const snoozedEl = screen.getByText("Snoozed");
    expect(snoozedEl.closest("[aria-disabled='true']")).toBeTruthy();

    expect(screen.getByText("Coming soon")).toBeTruthy();
  });

  it("Open settings button calls openSettings", async () => {
    const user = userEvent.setup();
    setupStore(null);
    setupMutations();
    const openSettingsSpy = vi.spyOn(useUiStore.getState(), "openSettings");
    mockUseAccounts.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    await user.click(screen.getByRole("button", { name: /open settings/i }));
    expect(openSettingsSpy).toHaveBeenCalled();
    openSettingsSpy.mockRestore();
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
    expect(useUiStore.getState().selectedSmartFolder).toBe("all_inboxes");
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
    expect(useUiStore.getState().selectedSmartFolder).toBe("unread");
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
    expect(useUiStore.getState().selectedSmartFolder).toBe("flagged");
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
    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
    expect(screen.getByText("Inbox")).toBeTruthy();
    await user.click(screen.getByText("Inbox"));
    expect(useUiStore.getState().selectedFolderId).toBe(10);
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

  it("typing in the search input updates the store and clears via the clear button", async () => {
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
    const input = screen.getByLabelText("Search mail");
    await user.type(input, "report");
    expect(useUiStore.getState().searchQuery).toBe("report");
    expect(useUiStore.getState().searchActive).toBe(true);

    await user.click(screen.getByLabelText("Clear search"));
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().searchActive).toBe(false);
  });

  it("drag-and-drop reorder calls reorderAccounts with swapped id order", () => {
    setupStore(1);
    setupMutations();
    mockUseAccounts.mockReturnValue({
      data: [accountWithReauth, accountNormal],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAccounts>);

    render(<MailboxRail />);

    expect(capturedOnDragEnd).not.toBeNull();
    capturedOnDragEnd!({ active: { id: 1 }, over: { id: 2 } });

    expect(mockReorderAccounts).toHaveBeenCalledWith([2, 1]);
  });
});
