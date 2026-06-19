import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { commands } from "./bindings";
import {
  useSignatures,
  useCreateSignature,
  useUpdateSignature,
  useSetDefaultSignature,
  useDeleteSignature,
} from "./queries";

vi.mock("./bindings", () => ({
  commands: {
    listSignatures: vi.fn().mockResolvedValue({
      status: "ok",
      data: [{ id: 1, name: "Work", html: "<p>BR</p>", is_default: true }],
    }),
    createSignature: vi.fn().mockResolvedValue({
      status: "ok",
      data: { id: 2, name: "Casual", html: "<p>Cheers</p>", is_default: false },
    }),
    updateSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    setDefaultSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    deleteSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("signature hooks", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("useSignatures fetches for the account", async () => {
    const { result } = renderHook(() => useSignatures(7), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(commands.listSignatures).toHaveBeenCalledWith(7);
  });

  it("useSignatures is disabled when account is null", async () => {
    const { result } = renderHook(() => useSignatures(null), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(commands.listSignatures).not.toHaveBeenCalled();
  });

  it("useCreateSignature calls command", async () => {
    const { result } = renderHook(() => useCreateSignature(), { wrapper: wrapper() });
    result.current.mutate({ accountId: 7, name: "Casual", html: "<p>x</p>", makeDefault: false });
    await waitFor(() =>
      expect(commands.createSignature).toHaveBeenCalledWith(7, "Casual", "<p>x</p>", false),
    );
  });

  it("useUpdateSignature calls command", async () => {
    const { result } = renderHook(() => useUpdateSignature(), { wrapper: wrapper() });
    result.current.mutate({ id: 3, name: "Job", html: "<p>y</p>", accountId: 7 });
    await waitFor(() =>
      expect(commands.updateSignature).toHaveBeenCalledWith(3, "Job", "<p>y</p>"),
    );
  });

  it("useSetDefaultSignature calls command", async () => {
    const { result } = renderHook(() => useSetDefaultSignature(), { wrapper: wrapper() });
    result.current.mutate({ accountId: 7, id: 3 });
    await waitFor(() => expect(commands.setDefaultSignature).toHaveBeenCalledWith(7, 3));
  });

  it("useDeleteSignature calls command", async () => {
    const { result } = renderHook(() => useDeleteSignature(), { wrapper: wrapper() });
    result.current.mutate({ id: 3, accountId: 7 });
    await waitFor(() => expect(commands.deleteSignature).toHaveBeenCalledWith(3));
  });
});
