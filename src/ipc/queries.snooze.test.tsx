import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { commands } from "./bindings";
import { useSnooze, useUnsnooze } from "./queries";

vi.mock("./bindings", () => ({
  commands: {
    snoozeMessages: vi.fn(() => Promise.resolve({ status: "ok", data: null })),
    unsnoozeMessages: vi.fn(() => Promise.resolve({ status: "ok", data: null })),
  },
}));

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useSnooze / useUnsnooze", () => {
  beforeEach(() => vi.clearAllMocks());

  it("snooze calls command and invalidates list keys", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSnooze(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ messageIds: [5], wakeAt: 9000 });
    });
    expect(commands.snoozeMessages).toHaveBeenCalledWith([5], 9000);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ["smart"] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ["threads"] });
    });
  });

  it("unsnooze calls command", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useUnsnooze(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync([5]);
    });
    expect(commands.unsnoozeMessages).toHaveBeenCalledWith([5]);
  });
});
