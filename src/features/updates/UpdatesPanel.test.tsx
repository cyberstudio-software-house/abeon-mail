import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { check, relaunch, getVersion, downloadAndInstall } = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(),
  downloadAndInstall: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => getVersion() }));

import { UpdatesPanel } from "./UpdatesPanel";

beforeEach(() => {
  vi.clearAllMocks();
  getVersion.mockResolvedValue("0.1.0");
});
afterEach(() => cleanup());

describe("UpdatesPanel", () => {
  it("shows the app version", async () => {
    const { getByText } = render(<UpdatesPanel />);
    await waitFor(() => expect(getByText(/0\.1\.0/)).toBeTruthy());
  });

  it("reports up to date when no update is available", async () => {
    check.mockResolvedValue(null);
    const { getByText } = render(<UpdatesPanel />);
    fireEvent.click(getByText("Check for updates"));
    await waitFor(() => expect(getByText(/up to date/i)).toBeTruthy());
  });

  it("offers install when an update is available", async () => {
    check.mockResolvedValue({ available: true, version: "0.2.0", downloadAndInstall });
    const { getByText } = render(<UpdatesPanel />);
    fireEvent.click(getByText("Check for updates"));
    await waitFor(() => expect(getByText(/0\.2\.0/)).toBeTruthy());
    expect(getByText("Download & install")).toBeTruthy();
  });

  it("surfaces an error when the check fails", async () => {
    check.mockRejectedValue(new Error("network"));
    const { getByText } = render(<UpdatesPanel />);
    fireEvent.click(getByText("Check for updates"));
    await waitFor(() => expect(getByText(/couldn't check/i)).toBeTruthy());
  });
});
