import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

import { SettingsOverlay } from "./SettingsOverlay";
import { AppearanceProvider } from "../../shared/appearance/AppearanceProvider";
import { useUiStore } from "../../app/store";

function renderOverlay() {
  return render(
    <AppearanceProvider>
      <SettingsOverlay />
    </AppearanceProvider>
  );
}

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true });
});

afterEach(cleanup);

describe("SettingsOverlay", () => {
  it("shows the eight nav sections with Appearance active by default", () => {
    renderOverlay();
    const sections = [
      "General",
      "Accounts",
      "Appearance",
      "Signatures",
      "Notifications",
      "Rules & Filters",
      "Snooze",
      "Shortcuts",
    ];
    for (const name of sections) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
  });

  it("switching to a non-appearance section shows a placeholder", () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
  });

  it("close button calls closeSettings", () => {
    const closeSettings = vi.fn();
    useUiStore.setState({ closeSettings });
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(closeSettings).toHaveBeenCalled();
  });

  it("Escape key closes the overlay", () => {
    const closeSettings = vi.fn();
    useUiStore.setState({ closeSettings });
    renderOverlay();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeSettings).toHaveBeenCalled();
  });
});
