import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { check, relaunch, getVersion, downloadAndInstall, openExternalUrl } = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(),
  downloadAndInstall: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => getVersion() }));
vi.mock("../../ipc/bindings", () => ({
  commands: { openExternalUrl: (url: string) => openExternalUrl(url) },
}));

import { UpdateAvailableBanner } from "./UpdateAvailableBanner";

beforeEach(() => {
  vi.clearAllMocks();
  getVersion.mockResolvedValue("0.1.3");
});
afterEach(() => cleanup());

describe("UpdateAvailableBanner", () => {
  it("auto-checks on mount and shows the banner when an update is available", async () => {
    check.mockResolvedValue({ available: true, version: "0.2.0", downloadAndInstall });
    const { getByText } = render(<UpdateAvailableBanner />);
    await waitFor(() => expect(getByText(/0\.2\.0/)).toBeTruthy());
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("stays hidden when the app is up to date", async () => {
    check.mockResolvedValue(null);
    const { container } = render(<UpdateAvailableBanner />);
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("stays hidden when the startup check fails", async () => {
    check.mockRejectedValue(new Error("offline"));
    const { container } = render(<UpdateAvailableBanner />);
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("installs and relaunches on click", async () => {
    check.mockResolvedValue({ available: true, version: "0.2.0", downloadAndInstall });
    downloadAndInstall.mockResolvedValue(undefined);
    relaunch.mockResolvedValue(undefined);
    const { getByText } = render(<UpdateAvailableBanner />);
    await waitFor(() => expect(getByText("Restart & update")).toBeTruthy());
    fireEvent.click(getByText("Restart & update"));
    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalled());
    await waitFor(() => expect(relaunch).toHaveBeenCalled());
  });

  it("surfaces a failure and offers a manual download when install fails", async () => {
    check.mockResolvedValue({ available: true, version: "0.2.0", downloadAndInstall });
    downloadAndInstall.mockRejectedValue(new Error("signature verification failed"));
    const { getByText, queryByText } = render(<UpdateAvailableBanner />);
    await waitFor(() => expect(getByText("Restart & update")).toBeTruthy());
    fireEvent.click(getByText("Restart & update"));
    await waitFor(() => expect(getByText(/Update failed/i)).toBeTruthy());
    expect(relaunch).not.toHaveBeenCalled();
    expect(queryByText("Restart & update")).toBeNull();
    fireEvent.click(getByText("Download"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/cyberstudio-software-house/abeon-mail/releases/latest",
    );
  });
});
