import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { setSeenMutate } = vi.hoisted(() => ({ setSeenMutate: vi.fn() }));

vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./CheatSheet", () => ({ CheatSheet: () => null }));
vi.mock("../labels/LabelPicker", () => ({ LabelPicker: () => null }));
vi.mock("../snooze/SnoozePicker", () => ({ SnoozePicker: () => null }));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

vi.mock("../../ipc/queries", () => ({
  useStartReply: () => ({ mutateAsync: vi.fn() }),
  useSetFlag: () => ({ mutate: vi.fn() }),
  useFolders: () => ({ data: [] }),
  useMoveToFolder: () => ({ mutate: vi.fn() }),
  useSetSeen: () => ({ mutate: setSeenMutate }),
  useUndoMove: () => ({ mutate: vi.fn() }),
  useArchive: () => ({ mutate: vi.fn() }),
  useDelete: () => ({ mutate: vi.fn() }),
}));

import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ selectedThreadId: null });
});

function renderProvider(threadId: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["thread-messages", threadId], [
    { id: 1, seen: true },
    { id: 2, seen: false },
  ]);
  return render(
    <QueryClientProvider client={qc}>
      <ShortcutsProvider>
        <div />
      </ShortcutsProvider>
    </QueryClientProvider>
  );
}

describe("ShortcutsProvider mark read/unread", () => {
  it("Shift+I marks unread messages in the open conversation read", async () => {
    useUiStore.setState({ selectedThreadId: 5, composer: { open: false, draftId: null, prefill: null } });
    renderProvider(5);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "I", shiftKey: true }));
    await waitFor(() => expect(setSeenMutate).toHaveBeenCalledWith({ ids: [2], value: true }));
  });

  it("Shift+U marks all messages in the open conversation unread", async () => {
    useUiStore.setState({ selectedThreadId: 5, composer: { open: false, draftId: null, prefill: null } });
    renderProvider(5);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "U", shiftKey: true }));
    await waitFor(() => expect(setSeenMutate).toHaveBeenCalledWith({ ids: [1, 2], value: false }));
  });
});
