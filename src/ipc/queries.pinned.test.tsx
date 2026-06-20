import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./bindings", () => ({
  commands: {
    getSettings: vi.fn(),
    setSetting: vi.fn(),
    listFolders: vi.fn(),
  },
  events: {},
}));

import { commands } from "./bindings";
import { usePinnedMap, useTogglePinnedFolder } from "./queries";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("pinned folder queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses settings into a pinned map", async () => {
    vi.mocked(commands.getSettings).mockResolvedValue({
      status: "ok",
      data: [["folders.pinned.2", "[3,9]"], ["images.autoload.1", "true"]],
    });
    const { result } = renderHook(() => usePinnedMap(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeInstanceOf(Map));
    expect(result.current.data!.get(2)).toEqual([3, 9]);
  });

  it("adds a folder id and persists the toggled list", async () => {
    vi.mocked(commands.getSettings).mockResolvedValue({
      status: "ok",
      data: [["folders.pinned.1", "[5]"]],
    });
    vi.mocked(commands.setSetting).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useTogglePinnedFolder(), { wrapper });
    result.current.mutate({ accountId: 1, folderId: 7 });
    await waitFor(() =>
      expect(commands.setSetting).toHaveBeenCalledWith("folders.pinned.1", "[5,7]"),
    );
  });

  it("removes a folder id when already pinned", async () => {
    vi.mocked(commands.getSettings).mockResolvedValue({
      status: "ok",
      data: [["folders.pinned.1", "[5,7]"]],
    });
    vi.mocked(commands.setSetting).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useTogglePinnedFolder(), { wrapper });
    result.current.mutate({ accountId: 1, folderId: 5 });
    await waitFor(() =>
      expect(commands.setSetting).toHaveBeenCalledWith("folders.pinned.1", "[7]"),
    );
  });
});
