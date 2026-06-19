import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { NotificationsProvider, useNotifications } from "./NotificationsProvider";

const { mockIsGranted, mockRequest } = vi.hoisted(() => ({
  mockIsGranted: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: vi.fn().mockResolvedValue({
      status: "ok",
      data: [["notifications.badge", "false"]],
    }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    refreshUnreadBadge: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mockIsGranted,
  requestPermission: mockRequest,
}));

function wrapper({ children }: { children: ReactNode }) {
  return <NotificationsProvider>{children}</NotificationsProvider>;
}

describe("NotificationsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGranted.mockResolvedValue(true);
    mockRequest.mockResolvedValue("granted");
    useUiStore.setState({ notificationsEnabled: true, badgeEnabled: true });
  });
  afterEach(() => cleanup());

  it("hydrates from settings", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.badgeEnabled).toBe(false));
    expect(result.current.notificationsEnabled).toBe(true);
  });

  it("requests OS permission when enabled and not yet granted", async () => {
    mockIsGranted.mockResolvedValue(false);
    renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
  });

  it("persists a toggle and updates the store", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.badgeEnabled).toBe(false));
    act(() => result.current.setNotificationsEnabled(false));
    await waitFor(() =>
      expect(commands.setSetting).toHaveBeenCalledWith("notifications.enabled", "false"),
    );
    expect(useUiStore.getState().notificationsEnabled).toBe(false);
  });

  it("refreshes the badge when badge setting changes", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(commands.refreshUnreadBadge).toHaveBeenCalled());
    act(() => result.current.setBadgeEnabled(true));
    await waitFor(() => expect(commands.refreshUnreadBadge).toHaveBeenCalledWith(true));
  });
});
