import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { NotificationsSection } from "./NotificationsSection";

const { setNotificationsEnabled, setBadgeEnabled, setTrayEnabled } = vi.hoisted(() => ({
  setNotificationsEnabled: vi.fn(),
  setBadgeEnabled: vi.fn(),
  setTrayEnabled: vi.fn(),
}));

vi.mock("../../shared/notifications/NotificationsProvider", () => ({
  useNotifications: () => ({
    notificationsEnabled: true,
    badgeEnabled: false,
    trayEnabled: false,
    permissionGranted: true,
    setNotificationsEnabled,
    setBadgeEnabled,
    setTrayEnabled,
  }),
}));

function wrap(ui: ReactNode) {
  return render(<>{ui}</>);
}

describe("NotificationsSection", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("renders both toggles reflecting current state", () => {
    const { getByLabelText } = wrap(<NotificationsSection />);
    expect(getByLabelText("Desktop notifications").getAttribute("aria-checked")).toBe("true");
    expect(getByLabelText("Unread badge").getAttribute("aria-checked")).toBe("false");
  });

  it("toggles desktop notifications", () => {
    const { getByLabelText } = wrap(<NotificationsSection />);
    fireEvent.click(getByLabelText("Desktop notifications"));
    expect(setNotificationsEnabled).toHaveBeenCalledWith(false);
  });

  it("toggles the unread badge", () => {
    const { getByLabelText } = wrap(<NotificationsSection />);
    fireEvent.click(getByLabelText("Unread badge"));
    expect(setBadgeEnabled).toHaveBeenCalledWith(true);
  });

  it("toggles minimize to tray", () => {
    const { getByLabelText } = wrap(<NotificationsSection />);
    fireEvent.click(getByLabelText("Minimize to tray on close"));
    expect(setTrayEnabled).toHaveBeenCalledWith(true);
  });
});
