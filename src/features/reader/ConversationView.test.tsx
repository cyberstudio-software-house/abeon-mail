import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listThreadMessages: vi.fn().mockResolvedValue({
      status: "ok",
      data: [
        {
          id: 1,
          account_id: 1,
          folder_id: 1,
          subject: "Hi",
          from_address: "a@x",
          from_name: "A",
          date: 1,
          seen: true,
          flagged: false,
          has_attachments: false,
          snippet: "",
        },
        {
          id: 2,
          account_id: 1,
          folder_id: 1,
          subject: "Re: Hi",
          from_address: "b@y",
          from_name: "B",
          date: 2,
          seen: false,
          flagged: false,
          has_attachments: false,
          snippet: "",
        },
      ],
    }),
    getMessageBody: vi.fn().mockResolvedValue({
      status: "ok",
      data: { message_id: 2, text_plain: "body", text_html: null },
    }),
    markMessageSeen: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

import { ConversationView } from "./ConversationView";

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

describe("ConversationView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders both message senders and last item is expanded with body", async () => {
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findByText("A");
    await screen.findByText("B");

    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("B")).toBeTruthy();

    await screen.findByText("body");
    expect(screen.getByText("body")).toBeTruthy();
  });
});
