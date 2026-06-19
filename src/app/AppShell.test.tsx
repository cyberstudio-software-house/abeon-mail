import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../ipc/events", () => ({
  useSyncEvents: vi.fn(),
}));

vi.mock("../features/startup/useStartupView", () => ({
  useStartupView: vi.fn(),
}));

vi.mock("../ipc/client", () => ({
  health: vi.fn(async () => "ok"),
}));

vi.mock("../ipc/queries", () => ({
  useAccounts: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useFolders: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useThreads: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useSmartFolder: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  useSearch: () => ({ data: [], isLoading: false }),
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
  useLabels: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useMessagesByLabel: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  useLabelsForMessages: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useSnooze: () => ({ mutate: vi.fn() }),
  useUnsnooze: () => ({ mutate: vi.fn() }),
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
      theme: "auto",
      accent: "#4f46e5",
      showPreview: true,
      showAvatars: true,
      settingsOpen: false,
      composer: { open: false, draftId: null, prefill: null },
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedMessageId: vi.fn(),
      setSelectedThreadId: vi.fn(),
      setSelectedSmartFolder: vi.fn(),
      setDensity: vi.fn(),
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      setShowPreview: vi.fn(),
      setShowAvatars: vi.fn(),
      hydrateAppearance: vi.fn(),
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      openComposer: vi.fn(),
      closeComposer: vi.fn(),
      visibleMessageIds: [],
      selectMode: "thread",
      replyTargetId: null,
      composerSend: null,
      paletteOpen: false,
      cheatSheetOpen: false,
      shortcutProfile: "default",
      shortcutOverrides: {},
      searchQuery: "",
      searchActive: false,
      focusSearch: null,
      setListContext: vi.fn(),
      setReplyTargetId: vi.fn(),
      setComposerSend: vi.fn(),
      togglePalette: vi.fn(),
      closePalette: vi.fn(),
      toggleCheatSheet: vi.fn(),
      closeCheatSheet: vi.fn(),
      setShortcutProfile: vi.fn(),
      setShortcutOverride: vi.fn(),
      resetShortcut: vi.fn(),
      hydrateShortcuts: vi.fn(),
      setSearchQuery: vi.fn(),
      clearSearch: vi.fn(),
      setFocusSearch: vi.fn(),
      selectedLabelId: null,
      selectionActive: false,
      selectedMessageIds: [],
      labelPickerOpen: false,
      labelPickerTargetIds: [],
      setSelectedLabelId: vi.fn(),
      toggleSelectionMode: vi.fn(),
      toggleMessageSelected: vi.fn(),
      clearSelection: vi.fn(),
      selectAll: vi.fn(),
      openLabelPicker: vi.fn(),
      closeLabelPicker: vi.fn(),
      snoozePickerOpen: false,
      snoozePickerTargetIds: [],
      openSnoozePicker: vi.fn(),
      closeSnoozePicker: vi.fn(),
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

});
