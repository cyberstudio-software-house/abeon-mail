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
          flagged: true,
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
    setMessageFlags: vi.fn().mockResolvedValue({ status: "ok", data: null }),
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

    await screen.findAllByText("A");
    await screen.findAllByText("B");

    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("B").length).toBeGreaterThan(0);

    await screen.findAllByText("body");
    expect(screen.getAllByText("body").length).toBeGreaterThan(0);
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

    await screen.findAllByText("B");

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

    await screen.findAllByText("B");

    const replyAllButton = await screen.findByRole("button", { name: "Reply all" });
    fireEvent.click(replyAllButton);

    await waitFor(() => {
      expect(commands.startReply).toHaveBeenCalledWith(2, "reply_all");
    });
  });

  it("clicking Forward calls startReply with mode forward", async () => {
    const { commands } = await import("../../ipc/bindings");
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    const forwardButton = await screen.findByRole("button", { name: "Forward" });
    fireEvent.click(forwardButton);

    await waitFor(() => {
      expect(commands.startReply).toHaveBeenCalledWith(2, "forward");
    });
  });

  it("Star toggles the flag on the latest message", async () => {
    const { commands } = await import("../../ipc/bindings");
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    const flagButton = await screen.findByRole("button", { name: "Flag" });
    fireEvent.click(flagButton);

    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "flagged", false);
    });
  });

  it("reader toolbar Archive/Snooze/Delete/More are disabled placeholders", async () => {
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    const archive = await screen.findByRole("button", { name: "Archive" });
    expect(archive.getAttribute("aria-disabled")).toBe("true");

    const snooze = await screen.findByRole("button", { name: "Snooze" });
    expect(snooze.getAttribute("aria-disabled")).toBe("true");

    const del = await screen.findByRole("button", { name: "Delete" });
    expect(del.getAttribute("aria-disabled")).toBe("true");

    const more = await screen.findByRole("button", { name: "More" });
    expect(more.getAttribute("aria-disabled")).toBe("true");
  });

  it("bottom reply trigger starts a reply", async () => {
    const { commands } = await import("../../ipc/bindings");
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    const trigger = await screen.findByRole("button", { name: /Reply to/ });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(commands.startReply).toHaveBeenCalledWith(2, "reply");
    });
  });
});
