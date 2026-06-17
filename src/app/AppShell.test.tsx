import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../ipc/client", () => ({
  health: vi.fn(async () => "ok"),
}));

vi.mock("../shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ mode: "light", setMode: vi.fn(), resolved: "light" }),
}));

vi.mock("../ipc/queries", () => ({
  useAccounts: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useFolders: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useMessages: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useMessageBody: () => ({ data: null, isLoading: false, isError: false, error: null }),
}));

vi.mock("../app/store", () => ({
  useUiStore: (selector: (s: unknown) => unknown) => {
    const state = {
      selectedAccountId: null,
      selectedFolderId: null,
      selectedMessageId: null,
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedMessageId: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders three panes and shows ipc status", async () => {
    render(<AppShell />);
    expect(screen.getByLabelText("message-list")).toBeTruthy();
    expect(screen.getByLabelText("reader")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("IPC: ok")).toBeTruthy());
  });
});
