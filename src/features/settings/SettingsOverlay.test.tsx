import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    listAccounts: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
  },
}));

import { SettingsOverlay } from "./SettingsOverlay";
import { AppearanceProvider } from "../../shared/appearance/AppearanceProvider";
import { useUiStore } from "../../app/store";

function renderOverlay() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AppearanceProvider>
        <SettingsOverlay />
      </AppearanceProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true });
});

afterEach(cleanup);

describe("SettingsOverlay", () => {
  it("shows the nine nav sections with Appearance active by default", () => {
    renderOverlay();
    const sections = [
      "General",
      "Accounts",
      "Appearance",
      "Labels",
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

  it("switching to Accounts shows the account management section", async () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(screen.getByRole("heading", { name: "Accounts" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add account" })).toBeTruthy()
    );
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
