import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../ipc/events", () => ({
  useSyncEvents: vi.fn(),
}));

vi.mock("../ipc/client", () => ({
  health: vi.fn(async () => "ok"),
}));

vi.mock("../shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ mode: "light", setMode: vi.fn(), resolved: "light" }),
}));

vi.mock("../ipc/queries", () => ({
  useAccounts: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useFolders: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useThreads: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useSmartFolder: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  useThreadMessages: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useMessageBody: () => ({ data: null, isLoading: false, isError: false, error: null }),
  useSetFlag: () => ({ mutate: vi.fn() }),
  useMarkSeen: () => ({ mutate: vi.fn() }),
  useStartReply: () => ({ mutateAsync: vi.fn() }),
  useSaveDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEnqueueSend: () => ({ mutateAsync: vi.fn() }),
  useRemoveAccount: () => ({ mutate: vi.fn(), isPending: false }),
  useBeginReauth: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderAccounts: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../ipc/bindings", () => ({
  commands: {
    sanitizeMessageHtml: vi.fn().mockResolvedValue({ html: "", blocked_remote_content: false }),
    listThreadMessages: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    getMessageBody: vi.fn().mockResolvedValue({ status: "ok", data: { message_id: 1, text_plain: null, text_html: null } }),
    markMessageSeen: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

vi.mock("../app/store", () => ({
  useUiStore: (selector: (s: unknown) => unknown) => {
    const state = {
      selectedAccountId: null,
      selectedFolderId: null,
      selectedMessageId: null,
      selectedThreadId: null,
      selectedSmartFolder: null,
      density: "comfortable",
      composer: { open: false, draftId: null, prefill: null },
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedMessageId: vi.fn(),
      setSelectedThreadId: vi.fn(),
      setSelectedSmartFolder: vi.fn(),
      setDensity: vi.fn(),
      openComposer: vi.fn(),
      closeComposer: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

import { AppShell } from "./AppShell";
import { useSyncEvents } from "../ipc/events";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("AppShell", () => {
  it("renders three panes and shows ipc status", async () => {
    render(<AppShell />, { wrapper: Wrapper });
    expect(screen.getByLabelText("message-list")).toBeTruthy();
    expect(screen.getByLabelText("reader")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("IPC: ok")).toBeTruthy());
  });

  it("mounts sync-event hook on render", () => {
    render(<AppShell />, { wrapper: Wrapper });
    expect(vi.mocked(useSyncEvents)).toHaveBeenCalled();
  });

  it("renders New message button", async () => {
    render(<AppShell />, { wrapper: Wrapper });
    const buttons = screen.getAllByRole("button", { name: "New message" });
    expect(buttons.length).toBeGreaterThan(0);
  });
});
