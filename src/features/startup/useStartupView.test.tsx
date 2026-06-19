import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";

const { useAccounts, useFolders } = vi.hoisted(() => ({
  useAccounts: vi.fn(),
  useFolders: vi.fn(),
}));

vi.mock("../../ipc/queries", () => ({ useAccounts, useFolders }));

import { useStartupView } from "./useStartupView";
import { useUiStore } from "../../app/store";

const ACCOUNTS = [
  { id: 2, email: "b@x.com", display_name: "B", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
  { id: 5, email: "a@x.com", display_name: "A", provider_type: "imap_password", color: null, position: 0, requires_reauth: false },
];

const FOLDERS = [
  { id: 30, account_id: 2, remote_path: "INBOX", name: "Inbox", folder_type: "inbox", unread_count: 0, total_count: 0 },
  { id: 31, account_id: 2, remote_path: "Sent", name: "Sent", folder_type: "sent", unread_count: 0, total_count: 0 },
];

function Harness() {
  useStartupView();
  return null;
}

beforeEach(() => {
  useAccounts.mockReset();
  useFolders.mockReset().mockReturnValue({ data: undefined });
  useUiStore.setState({
    selectedAccountId: null,
    selectedFolderId: null,
    selectedSmartFolder: null,
    selectedLabelId: null,
    defaultAccountId: "",
    generalHydrated: false,
  });
});

afterEach(() => cleanup());

describe("useStartupView", () => {
  it("opens the explicit default account's inbox", async () => {
    useAccounts.mockReturnValue({ data: ACCOUNTS });
    useFolders.mockImplementation((id: number | null) => ({ data: id === 2 ? FOLDERS : undefined }));
    useUiStore.setState({ defaultAccountId: "2", generalHydrated: true });

    render(<Harness />);

    await waitFor(() => expect(useUiStore.getState().selectedAccountId).toBe(2));
    await waitFor(() => expect(useUiStore.getState().selectedFolderId).toBe(30));
  });

  it("falls back to the first account by position when the default is missing", async () => {
    useAccounts.mockReturnValue({ data: ACCOUNTS });
    useFolders.mockImplementation((id: number | null) => ({ data: id === 5 ? FOLDERS : undefined }));
    useUiStore.setState({ defaultAccountId: "999", generalHydrated: true });

    render(<Harness />);

    await waitFor(() => expect(useUiStore.getState().selectedAccountId).toBe(5));
  });

  it("does nothing when a selection already exists", async () => {
    useAccounts.mockReturnValue({ data: ACCOUNTS });
    useUiStore.setState({ generalHydrated: true, selectedSmartFolder: "all_inboxes" });

    render(<Harness />);

    await new Promise((r) => setTimeout(r, 20));
    expect(useUiStore.getState().selectedAccountId).toBeNull();
  });

  it("does nothing while general settings are not hydrated", async () => {
    useAccounts.mockReturnValue({ data: ACCOUNTS });
    useUiStore.setState({ generalHydrated: false });

    render(<Harness />);

    await new Promise((r) => setTimeout(r, 20));
    expect(useUiStore.getState().selectedAccountId).toBeNull();
  });

  it("does nothing when there are no accounts", async () => {
    useAccounts.mockReturnValue({ data: [] });
    useUiStore.setState({ generalHydrated: true });

    render(<Harness />);

    await new Promise((r) => setTimeout(r, 20));
    expect(useUiStore.getState().selectedAccountId).toBeNull();
  });
});
