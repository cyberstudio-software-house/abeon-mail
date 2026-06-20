import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./bindings", () => ({
  commands: {
    setMessageFlags: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    refreshUnreadBadge: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

import { commands } from "./bindings";
import { useSetSeen } from "./queries";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSetSeen", () => {
  it("calls setMessageFlags for each id with value true", async () => {
    const { result } = renderHook(() => useSetSeen(), { wrapper });
    result.current.mutate({ ids: [1, 2], value: true });
    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(1, "seen", true);
      expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "seen", true);
    });
  });

  it("passes value false for mark unread", async () => {
    const { result } = renderHook(() => useSetSeen(), { wrapper });
    result.current.mutate({ ids: [5], value: false });
    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(5, "seen", false);
    });
  });
});
