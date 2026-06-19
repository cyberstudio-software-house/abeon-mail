import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

const startReply = vi.fn().mockResolvedValue({});
const setFlagMutate = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useStartReply: () => ({ mutateAsync: startReply }),
  useSetFlag: () => ({ mutate: setFlagMutate }),
  useFolders: () => ({ data: [] }),
  useLabels: () => ({ data: [] }),
  useLabelsForMessages: () => ({ data: [] }),
  useCreateLabel: () => ({ mutateAsync: vi.fn() }),
  useSetMessageLabels: () => ({ mutate: vi.fn() }),
}));

import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

function renderProvider(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ShortcutsProvider>{children}</ShortcutsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useUiStore.setState({
    composer: { open: false, draftId: null, prefill: null },
    selectedThreadId: null,
    selectedSmartFolder: null,
    visibleMessageIds: [],
    selectMode: "thread",
    replyTargetId: null,
    paletteOpen: false,
    cheatSheetOpen: false,
    shortcutProfile: "default",
    shortcutOverrides: {},
  });
  startReply.mockClear();
  setFlagMutate.mockClear();
});
afterEach(cleanup);

describe("ShortcutsProvider", () => {
  it("compose shortcut opens the composer", async () => {
    renderProvider(<div />);
    fireEvent.keyDown(window, { key: "c" });
    await waitFor(() => expect(useUiStore.getState().composer.open).toBe(true));
  });

  it("Mod+K toggles the palette", () => {
    renderProvider(<div />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useUiStore.getState().paletteOpen).toBe(true);
  });

  it("j moves selection to the next visible thread", () => {
    useUiStore.setState({ visibleMessageIds: [10, 20, 30], selectMode: "thread", selectedThreadId: 10 });
    renderProvider(<div />);
    fireEvent.keyDown(window, { key: "j" });
    expect(useUiStore.getState().selectedThreadId).toBe(20);
  });

  it("reply (reader context) calls startReply with the reply target", async () => {
    useUiStore.setState({ selectedThreadId: 5, replyTargetId: 42 });
    renderProvider(<div />);
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(startReply).toHaveBeenCalledWith({ messageId: 42, mode: "reply" }));
  });
});
