import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUiStore } from "../app/store";
import { useSyncEvents } from "./events";

const h = vi.hoisted(() => ({
  newMessagesCb: null as ((e: { payload: { account_id: number; folder_id: number; count: number } }) => void) | null,
  prefetchProgressCb: null as ((e: { payload: { account_id: number; done: number; total: number } }) => void) | null,
  sendNotification: vi.fn(),
  isFocused: vi.fn(),
  isPermissionGranted: vi.fn(),
  buildNewMailNotification: vi.fn(),
  refreshUnreadBadge: vi.fn(),
}));

vi.mock("./bindings", () => ({
  commands: {
    buildNewMailNotification: h.buildNewMailNotification,
    refreshUnreadBadge: h.refreshUnreadBadge,
  },
  events: {
    syncProgress: { listen: vi.fn().mockResolvedValue(() => {}) },
    newMessages: {
      listen: vi.fn((cb) => {
        h.newMessagesCb = cb;
        return Promise.resolve(() => {});
      }),
    },
    mailboxChanged: { listen: vi.fn().mockResolvedValue(() => {}) },
    accountAuthChanged: { listen: vi.fn().mockResolvedValue(() => {}) },
    snoozeWoke: { listen: vi.fn().mockResolvedValue(() => {}) },
    prefetchProgress: {
      listen: vi.fn((cb) => {
        h.prefetchProgressCb = cb;
        return Promise.resolve(() => {});
      }),
    },
    sendFailed: { listen: vi.fn().mockResolvedValue(() => {}) },
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: h.isFocused }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: h.isPermissionGranted,
  sendNotification: h.sendNotification,
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useSyncEvents notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.newMessagesCb = null;
    h.prefetchProgressCb = null;
    h.isFocused.mockResolvedValue(false);
    h.isPermissionGranted.mockResolvedValue(true);
    h.buildNewMailNotification.mockResolvedValue({ status: "ok", data: { title: "Alice", body: "Hi" } });
    h.refreshUnreadBadge.mockResolvedValue({ status: "ok", data: null });
    useUiStore.setState({ notificationsEnabled: true, badgeEnabled: true });
  });
  afterEach(() => cleanup());

  it("notifies on new mail when unfocused and refreshes the badge", async () => {
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.newMessagesCb).not.toBeNull());
    h.newMessagesCb!({ payload: { account_id: 1, folder_id: 2, count: 1 } });
    await waitFor(() => expect(h.sendNotification).toHaveBeenCalledWith({ title: "Alice", body: "Hi" }));
    expect(h.buildNewMailNotification).toHaveBeenCalledWith(2, 1);
    await waitFor(() => expect(h.refreshUnreadBadge).toHaveBeenCalledWith(true));
  });

  it("does not notify when the window is focused", async () => {
    h.isFocused.mockResolvedValue(true);
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.newMessagesCb).not.toBeNull());
    h.newMessagesCb!({ payload: { account_id: 1, folder_id: 2, count: 1 } });
    await waitFor(() => expect(h.refreshUnreadBadge).toHaveBeenCalled());
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when notifications are disabled", async () => {
    useUiStore.setState({ notificationsEnabled: false, badgeEnabled: true });
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.newMessagesCb).not.toBeNull());
    h.newMessagesCb!({ payload: { account_id: 1, folder_id: 2, count: 1 } });
    await waitFor(() => expect(h.refreshUnreadBadge).toHaveBeenCalled());
    expect(h.buildNewMailNotification).not.toHaveBeenCalled();
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it("records prefetch progress into the store", async () => {
    useUiStore.setState({ prefetchProgress: {} });
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.prefetchProgressCb).not.toBeNull());
    h.prefetchProgressCb!({ payload: { account_id: 1, done: 4, total: 10 } });
    await waitFor(() =>
      expect(useUiStore.getState().prefetchProgress[1]).toEqual({ done: 4, total: 10 }),
    );
  });
});
