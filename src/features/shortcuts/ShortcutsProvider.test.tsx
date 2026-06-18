import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

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
}));

import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

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
    render(<ShortcutsProvider><div /></ShortcutsProvider>);
    fireEvent.keyDown(window, { key: "c" });
    await waitFor(() => expect(useUiStore.getState().composer.open).toBe(true));
  });

  it("Mod+K toggles the palette", () => {
    render(<ShortcutsProvider><div /></ShortcutsProvider>);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useUiStore.getState().paletteOpen).toBe(true);
  });

  it("j moves selection to the next visible thread", () => {
    useUiStore.setState({ visibleMessageIds: [10, 20, 30], selectMode: "thread", selectedThreadId: 10 });
    render(<ShortcutsProvider><div /></ShortcutsProvider>);
    fireEvent.keyDown(window, { key: "j" });
    expect(useUiStore.getState().selectedThreadId).toBe(20);
  });

  it("reply (reader context) calls startReply with the reply target", async () => {
    useUiStore.setState({ selectedThreadId: 5, replyTargetId: 42 });
    render(<ShortcutsProvider><div /></ShortcutsProvider>);
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(startReply).toHaveBeenCalledWith({ messageId: 42, mode: "reply" }));
  });
});
