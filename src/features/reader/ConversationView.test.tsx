import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const archiveMutate = vi.fn();
const deleteMutate = vi.fn();
vi.mock("../../ipc/queries", async (orig) => {
  const actual = await orig<typeof import("../../ipc/queries")>();
  return {
    ...actual,
    useArchive: () => ({ mutate: archiveMutate }),
    useDelete: () => ({ mutate: deleteMutate }),
  };
});

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
          answered: false,
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
          answered: true,
        },
      ],
    }),
    getMessageBody: vi.fn().mockResolvedValue({
      status: "ok",
      data: { message_id: 2, text_plain: "body", text_html: null },
    }),
    renderMessageHtml: vi.fn().mockResolvedValue({
      status: "ok",
      data: { html: null, blocked_remote_content: false, remote_loaded: false },
    }),
    listAttachments: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
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
    refreshUnreadBadge: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    listAccounts: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    messageRecipients: vi.fn().mockResolvedValue({ status: "ok", data: { to: [], cc: [] } }),
    labelsForMessages: vi.fn().mockResolvedValue({
      status: "ok",
      data: [[2, { id: 1, name: "Work", color: "#4f46e5" }]],
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
    useUiStore.setState({
      composer: { open: false, draftId: null, prefill: null },
      generalHydrated: true,
      markReadMode: "immediate",
      markReadDelaySeconds: 2,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    archiveMutate.mockReset();
    deleteMutate.mockReset();
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

  it("shows answered indicator on a message that was answered", async () => {
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    expect(screen.getByTitle("Odpowiedziano")).toBeTruthy();
  });

  it("immediate mode marks the unread message as read after the thread loads", async () => {
    const { commands } = await import("../../ipc/bindings");
    useUiStore.setState({ generalHydrated: true, markReadMode: "immediate" });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "seen", true);
    });
    expect(commands.setMessageFlags).not.toHaveBeenCalledWith(1, "seen", true);
  });

  it("never mode does not auto-mark any message", async () => {
    const { commands } = await import("../../ipc/bindings");
    useUiStore.setState({ generalHydrated: true, markReadMode: "never" });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");
    expect(commands.setMessageFlags).not.toHaveBeenCalled();
  });

  it("toolbar Mark as read button marks the unread message read", async () => {
    const { commands } = await import("../../ipc/bindings");
    useUiStore.setState({ generalHydrated: true, markReadMode: "never" });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    const btn = await screen.findByRole("button", { name: "Mark as read" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "seen", true);
    });
  });

  it("delay mode marks the unread message only after the configured delay", async () => {
    const { commands } = await import("../../ipc/bindings");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      ["thread-messages", 1],
      [
        { id: 1, account_id: 1, folder_id: 1, subject: "Hi", from_address: "a@x", from_name: "A", date: 1, seen: true, flagged: false, has_attachments: false, snippet: "" },
        { id: 2, account_id: 1, folder_id: 1, subject: "Re: Hi", from_address: "b@y", from_name: "B", date: 2, seen: false, flagged: true, has_attachments: false, snippet: "" },
      ]
    );
    useUiStore.setState({ generalHydrated: true, markReadMode: "delay", markReadDelaySeconds: 2 });
    vi.useFakeTimers();
    render(
      <QueryClientProvider client={qc}>
        <ConversationView threadId={1} />
      </QueryClientProvider>
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.setMessageFlags).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "seen", true);
    vi.useRealTimers();
  });

  it("delay mode does NOT mark read if the conversation is manually marked unread during the window", async () => {
    const { commands } = await import("../../ipc/bindings");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      ["thread-messages", 1],
      [
        { id: 1, account_id: 1, folder_id: 1, subject: "Hi", from_address: "a@x", from_name: "A", date: 1, seen: true, flagged: false, has_attachments: false, snippet: "" },
        { id: 2, account_id: 1, folder_id: 1, subject: "Re: Hi", from_address: "b@y", from_name: "B", date: 2, seen: false, flagged: true, has_attachments: false, snippet: "" },
      ]
    );
    useUiStore.setState({ generalHydrated: true, markReadMode: "delay", markReadDelaySeconds: 2 });
    vi.useFakeTimers();
    render(
      <QueryClientProvider client={qc}>
        <ConversationView threadId={1} />
      </QueryClientProvider>
    );
    await vi.advanceTimersByTimeAsync(0);
    useUiStore.getState().bumpMarkUnreadEpoch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(commands.setMessageFlags).not.toHaveBeenCalled();
    vi.useRealTimers();
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

    const flagButton = await screen.findByRole("button", { name: "Remove importance" });
    fireEvent.click(flagButton);

    await waitFor(() => {
      expect(commands.setMessageFlags).toHaveBeenCalledWith(2, "flagged", false);
    });
  });

  it("reader toolbar More opens a menu with additional actions", async () => {
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    const more = await screen.findByRole("button", { name: "More actions" });
    expect(more.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(more);

    expect(await screen.findByRole("menuitem", { name: "Move to folder…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Mark as unread" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Remove importance" })).toBeTruthy();
  });

  it("archive button is enabled and not aria-disabled", async () => {
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    const btn = await screen.findByRole("button", { name: "Archive" });
    expect(btn.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("clicking Archive calls archive mutate with thread message ids and advances to the next", async () => {
    useUiStore.setState({
      selectMode: "thread",
      visibleMessageIds: [1, 2, 3],
      selectedRowIds: [1],
      selectedThreadId: 1,
      selectedMessageId: null,
      undoToast: null,
    });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    expect(archiveMutate).toHaveBeenCalledWith({ messageIds: [1, 2] });
    expect(useUiStore.getState().undoToast).toEqual({ kind: "archive", messageIds: [1, 2] });
    expect(useUiStore.getState().selectedThreadId).toBe(2);
  });

  it("clicking Delete calls delete mutate with thread message ids and advances to the next", async () => {
    useUiStore.setState({
      selectMode: "thread",
      visibleMessageIds: [1, 2, 3],
      selectedRowIds: [1],
      selectedThreadId: 1,
      selectedMessageId: null,
      undoToast: null,
    });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(deleteMutate).toHaveBeenCalledWith({ messageIds: [1, 2] });
    expect(useUiStore.getState().undoToast).toEqual({ kind: "delete", messageIds: [1, 2] });
    expect(useUiStore.getState().selectedThreadId).toBe(2);
  });

  it("Snooze button opens the picker for all messages in the conversation", async () => {
    useUiStore.setState({ snoozePickerOpen: false, snoozePickerTargetIds: [] });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));

    expect(useUiStore.getState().snoozePickerOpen).toBe(true);
    expect(useUiStore.getState().snoozePickerTargetIds).toEqual([1, 2]);
  });

  it("shows label chips and opens picker when Label button is clicked", async () => {
    useUiStore.setState({ labelPickerOpen: false, labelPickerTargetIds: [] });
    render(<ConversationView threadId={1} />, { wrapper: Wrapper });

    await screen.findAllByText("B");

    await waitFor(() => {
      expect(screen.getByText("Work")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Label" }));

    expect(useUiStore.getState().labelPickerOpen).toBe(true);
    expect(useUiStore.getState().labelPickerTargetIds).toEqual([2]);
  });
});
