import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./bindings", () => ({
  commands: {
    listAccounts: vi.fn(),
    listFolders: vi.fn(),
    listMessages: vi.fn(),
    getMessageBody: vi.fn(),
    resolveEndpoints: vi.fn(),
    addAccount: vi.fn(),
    appHealth: vi.fn(),
    sanitizeMessageHtml: vi.fn(),
    listLabels: vi.fn(),
    labelsForMessages: vi.fn(),
    listMessagesByLabel: vi.fn(),
    createLabel: vi.fn(),
    renameLabel: vi.fn(),
    setLabelColor: vi.fn(),
    deleteLabel: vi.fn(),
    setMessageLabels: vi.fn(),
  },
  events: {
    syncProgress: { listen: vi.fn() },
    newMessages: { listen: vi.fn() },
  },
}));

import { commands } from "./bindings";
import { useAccounts, useLabels, useLabelsForMessages, useMessagesByLabel } from "./queries";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function AccountsList() {
  const { data, isError } = useAccounts();
  if (isError) return <span>error</span>;
  return (
    <ul>
      {(data ?? []).map((a) => (
        <li key={a.id}>{a.email}</li>
      ))}
    </ul>
  );
}

describe("useAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns account data from listAccounts", async () => {
    vi.mocked(commands.listAccounts).mockResolvedValue({
      status: "ok",
      data: [
        {
          id: 1,
          email: "test@example.com",
          display_name: "Test",
          provider_type: "imap_password",
          color: null,
          position: 0,
          requires_reauth: false,
        },
      ],
    });

    render(<AccountsList />, { wrapper });

    await waitFor(() => expect(screen.getByText("test@example.com")).toBeTruthy());
  });

  it("throws when listAccounts returns error status", async () => {
    vi.mocked(commands.listAccounts).mockResolvedValue({
      status: "error",
      error: "DB failure",
    });

    render(<AccountsList />, { wrapper });

    await waitFor(() => expect(screen.getByText("error")).toBeTruthy());
  });
});

describe("label hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("useLabels fetches labels", async () => {
    vi.mocked(commands.listLabels).mockResolvedValue({
      status: "ok",
      data: [{ id: 1, name: "Work", color: "#4f46e5" }],
    });
    const { result } = renderHook(() => useLabels(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].name).toBe("Work");
  });

  it("useLabelsForMessages is disabled for empty ids", () => {
    const { result } = renderHook(() => useLabelsForMessages([]), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("useMessagesByLabel is disabled when labelId is null", () => {
    const { result } = renderHook(() => useMessagesByLabel(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
  });
});
