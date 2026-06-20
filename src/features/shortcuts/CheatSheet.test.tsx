import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("./ShortcutsProvider", () => ({
  useShortcuts: () => ({
    profile: "default",
    resolved: {
      compose: "c",
      reply: "r",
      "first-message": null,
      archive: "e",
    },
    overrides: {},
    setProfile: vi.fn(),
    setBinding: vi.fn(),
    resetBinding: vi.fn(),
  }),
}));

import { CheatSheet } from "./CheatSheet";
import { useUiStore } from "../../app/store";

beforeEach(() => {
  useUiStore.setState({ cheatSheetOpen: true, closeCheatSheet: vi.fn() });
});
afterEach(cleanup);

describe("CheatSheet", () => {
  it("does not render when closed", () => {
    useUiStore.setState({ cheatSheetOpen: false });
    const { container } = render(<CheatSheet />);
    expect(container.firstChild).toBeNull();
  });

  it("shows actions grouped by context with their bindings", () => {
    render(<CheatSheet />);
    expect(screen.getByText("Compose")).toBeTruthy();
    expect(screen.getByText("Reply")).toBeTruthy();
    expect(screen.getByText("C")).toBeTruthy();
  });

  it("does not mark archive as coming soon", () => {
    render(<CheatSheet />);
    const archiveRows = screen.getAllByText("Archive");
    for (const row of archiveRows) {
      const archiveRow = row.closest(".cheat-row");
      expect(archiveRow?.className).not.toContain("cheat-row--disabled");
    }
  });

  it("closes on the close button", () => {
    const closeCheatSheet = vi.fn();
    useUiStore.setState({ closeCheatSheet });
    render(<CheatSheet />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(closeCheatSheet).toHaveBeenCalled();
  });
});
