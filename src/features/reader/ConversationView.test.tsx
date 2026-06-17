import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
    startReply: vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        from_address: "me@example.com",
        from_name: "Me",
        to: ["a@x"],
        cc: [],
        bcc: [],
        subject: "Re: Hi",
        text_body: "",
        html_body: "<blockquote>original</blockquote>",
        in_reply_to: "msg-1",
        references: [],
        attachments: [],
      },
    }),
  },
  events: {},
}));

vi.mock("../../app/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/store")>();
  return actual;
});

import { useUiStore } from "../../app/store";
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
  beforeEach(() => {
    useUiStore.setState({ composer: { open: false, draftId: null, prefill: null } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useUiStore.setState({ composer: { open: false, draftId: null, prefill: null } });
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

  it("calls markMessageSeen for the newest message after thread loads", async () => {
    const { commands } = await import("../../ipc/bindings");
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(commands.markMessageSeen).toHaveBeenCalledWith(2);
    });
  });

  it("clicking Reply calls startReply with message id and mode reply and opens composer", async () => {
    const { commands } = await import("../../ipc/bindings");
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findByText("B");
    await screen.findByText("body");

    const replyButton = await screen.findByRole("button", { name: "Reply" });
    fireEvent.click(replyButton);

    await waitFor(() => {
      expect(commands.startReply).toHaveBeenCalledWith(2, "reply");
    });

    await waitFor(() => {
      expect(useUiStore.getState().composer.open).toBe(true);
    });

    const prefill = useUiStore.getState().composer.prefill;
    expect(prefill).not.toBeNull();
    expect(prefill?.html_body).toContain("blockquote");
  });

  it("clicking Reply all calls startReply with mode reply_all", async () => {
    const { commands } = await import("../../ipc/bindings");
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findByText("B");
    await screen.findByText("body");

    const replyAllButton = await screen.findByRole("button", { name: "Reply all" });
    fireEvent.click(replyAllButton);

    await waitFor(() => {
      expect(commands.startReply).toHaveBeenCalledWith(2, "reply_all");
    });
  });

  it("clicking Forward calls startReply with mode forward", async () => {
    const { commands } = await import("../../ipc/bindings");
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findByText("B");
    await screen.findByText("body");

    const forwardButton = await screen.findByRole("button", { name: "Forward" });
    fireEvent.click(forwardButton);

    await waitFor(() => {
      expect(commands.startReply).toHaveBeenCalledWith(2, "forward");
    });
  });
});
