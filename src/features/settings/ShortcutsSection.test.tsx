import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const setProfile = vi.fn();
const setBinding = vi.fn();
const resetBinding = vi.fn();

vi.mock("../shortcuts/ShortcutsProvider", () => ({
  useShortcuts: () => ({
    profile: "default",
    resolved: {
      compose: "c",
      reply: "r",
      "command-palette": "Mod+k",
    },
    overrides: {},
    setProfile,
    setBinding,
    resetBinding,
  }),
}));

import { ShortcutsSection } from "./ShortcutsSection";

beforeEach(() => {
  setProfile.mockClear();
  setBinding.mockClear();
  resetBinding.mockClear();
});
afterEach(cleanup);

describe("ShortcutsSection", () => {
  it("offers the Default and Vim profiles", () => {
    render(<ShortcutsSection />);
    expect(screen.getByRole("button", { name: "Default" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vim" })).toBeTruthy();
  });

  it("switching profile calls setProfile", () => {
    render(<ShortcutsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Vim" }));
    expect(setProfile).toHaveBeenCalledWith("vim");
  });

  it("lists actions with their bindings", () => {
    render(<ShortcutsSection />);
    expect(screen.getByText("Compose")).toBeTruthy();
    expect(screen.getByText("Reply")).toBeTruthy();
  });

  it("reset calls resetBinding for the action", () => {
    render(<ShortcutsSection />);
    const composeRow = screen.getByText("Compose").closest(".shortcut-row")!;
    fireEvent.click(composeRow.querySelector("[aria-label='Reset Compose']")!);
    expect(resetBinding).toHaveBeenCalledWith("compose");
  });
});
