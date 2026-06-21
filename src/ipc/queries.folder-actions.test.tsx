import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./bindings", () => ({
  commands: {
    markFolderRead: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    createSubfolder: vi.fn(),
    refreshUnreadBadge: vi.fn(),
  },
  events: {},
}));

import { commands } from "./bindings";
import { useMarkFolderRead, useRenameFolder, useCreateSubfolder } from "./queries";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("folder action hooks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("markFolderRead calls the command with the folder id", async () => {
    vi.mocked(commands.markFolderRead).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useMarkFolderRead(), { wrapper });
    result.current.mutate(7);
    await waitFor(() => expect(commands.markFolderRead).toHaveBeenCalledWith(7));
  });

  it("renameFolder passes folderId and newName", async () => {
    vi.mocked(commands.renameFolder).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useRenameFolder(), { wrapper });
    result.current.mutate({ folderId: 3, newName: "Job" });
    await waitFor(() => expect(commands.renameFolder).toHaveBeenCalledWith(3, "Job"));
  });

  it("createSubfolder passes parentId and name", async () => {
    vi.mocked(commands.createSubfolder).mockResolvedValue({ status: "ok", data: null });
    const { result } = renderHook(() => useCreateSubfolder(), { wrapper });
    result.current.mutate({ parentId: 5, name: "Sub" });
    await waitFor(() => expect(commands.createSubfolder).toHaveBeenCalledWith(5, "Sub"));
  });
});
