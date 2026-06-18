import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const getSettings = vi.fn();
const setSetting = vi.fn().mockResolvedValue({ status: "ok", data: null });

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: () => getSettings(),
    setSetting: (k: string, v: string) => setSetting(k, v),
  },
}));

import { AppearanceProvider, useAppearance } from "./AppearanceProvider";
import { useUiStore } from "../../app/store";

function Probe() {
  const a = useAppearance();
  return (
    <div>
      <span data-testid="theme">{a.theme}</span>
      <button onClick={() => a.setTheme("dark")}>set-dark</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({
    status: "ok",
    data: [["appearance.theme", "light"]],
  });
  setSetting.mockClear();
  useUiStore.setState({ theme: "auto", accent: "#4f46e5", density: "comfortable", showPreview: true, showAvatars: true });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--accent");
});

describe("AppearanceProvider", () => {
  it("hydrates store from getSettings on mount", async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>
    );
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("light"));
  });

  it("applies data-theme and --accent to the document element", async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>
    );
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#4f46e5");
  });

  it("setTheme updates store and persists via setSetting", async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>
    );
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("light"));
    fireEvent.click(screen.getByText("set-dark"));
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("dark"));
    expect(setSetting).toHaveBeenCalledWith("appearance.theme", "dark");
  });
});
