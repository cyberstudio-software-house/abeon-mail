import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  },
  events: {
    syncProgress: { listen: vi.fn() },
    newMessages: { listen: vi.fn() },
  },
}));

import { commands } from "./bindings";
import { useAccounts } from "./queries";

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
