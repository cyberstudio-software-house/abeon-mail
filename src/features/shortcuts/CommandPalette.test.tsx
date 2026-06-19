import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("./ShortcutsProvider", () => ({
  useShortcuts: () => ({
    profile: "default",
    resolved: { compose: "c", "command-palette": "Mod+k" },
    overrides: {},
    setProfile: vi.fn(),
    setBinding: vi.fn(),
    resetBinding: vi.fn(),
  }),
}));

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({ data: [{ id: 1, email: "a@b.c" }] }),
  useFolders: () => ({ data: [{ id: 7, name: "Inbox" }] }),
}));

import { CommandPalette } from "./CommandPalette";
import { useUiStore } from "../../app/store";

beforeEach(() => {
  useUiStore.setState({
    paletteOpen: true,
    selectedAccountId: 1,
    closePalette: vi.fn(),
    openComposer: vi.fn(),
    setSelectedFolderId: vi.fn(),
  });
});
afterEach(cleanup);

describe("CommandPalette", () => {
  it("does not render when closed", () => {
    useUiStore.setState({ paletteOpen: false });
    const { container } = render(<CommandPalette />);
    expect(container.firstChild).toBeNull();
  });

  it("lists enabled actions and folders", () => {
    render(<CommandPalette />);
    expect(screen.getByText("Compose")).toBeTruthy();
    expect(screen.getByText("Inbox")).toBeTruthy();
  });

  it("filters by query", () => {
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(/type a command/i);
    fireEvent.change(input, { target: { value: "compo" } });
    expect(screen.getByText("Compose")).toBeTruthy();
    expect(screen.queryByText("Inbox")).toBeNull();
  });

  it("running an action closes the palette and invokes its handler", () => {
    const openComposer = vi.fn();
    const closePalette = vi.fn();
    useUiStore.setState({ openComposer, closePalette });
    render(<CommandPalette />);
    fireEvent.click(screen.getByText("Compose"));
    expect(openComposer).toHaveBeenCalled();
    expect(closePalette).toHaveBeenCalled();
  });
});
