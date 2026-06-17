import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSetFlag } from "./queries";

vi.mock("./bindings", () => ({
  commands: { setMessageFlags: vi.fn().mockResolvedValue({ status: "ok", data: null }) },
  events: {},
}));

import { commands } from "./bindings";

describe("useSetFlag", () => {
  it("calls setMessageFlags with flag and value", async () => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSetFlag(), { wrapper });
    result.current.mutate({ messageId: 5, flag: "seen", value: true });
    await waitFor(() => expect(commands.setMessageFlags).toHaveBeenCalledWith(5, "seen", true));
  });
});
