import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listAccounts: vi.fn().mockResolvedValue({
      status: "ok",
      data: [{ id: 7, email: "me@example.com", display_name: "Me", provider_type: "imap_password", color: null, position: 0 }],
    }),
    saveDraft: vi.fn().mockResolvedValue({ status: "ok", data: 1 }),
    enqueueSend: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    listSignatures: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    pickAttachment: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
  },
  events: {},
}));

vi.mock("@tiptap/react", () => {
  const editorInstance = {
    isActive: () => false,
    getText: () => "Hello world",
    getHTML: () => "<p>Hello world</p>",
    chain: () => ({
      focus: () => ({
        toggleBold: () => ({ run: vi.fn() }),
        toggleItalic: () => ({ run: vi.fn() }),
        toggleBulletList: () => ({ run: vi.fn() }),
        setLink: () => ({ run: vi.fn() }),
        insertContent: () => ({ run: vi.fn() }),
      }),
    }),
    destroy: vi.fn(),
  };

  return {
    useEditor: () => editorInstance,
    EditorContent: ({ editor }: { editor: unknown }) =>
      editor ? <textarea data-testid="editor" defaultValue="Hello world" /> : null,
  };
});

vi.mock("../../app/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/store")>();
  return actual;
});

import { useUiStore } from "../../app/store";
import { Composer } from "./Composer";

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

describe("Composer", () => {
  beforeEach(() => {
    useUiStore.setState({ composer: { open: true, draftId: null } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useUiStore.setState({ composer: { open: false, draftId: null } });
  });

  it("renders when composer is open", async () => {
    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("calls saveDraft then enqueueSend with the returned id when Send is clicked", async () => {
    const { commands } = await import("../../ipc/bindings");

    render(<Composer />, { wrapper: Wrapper });

    await screen.findByRole("dialog");

    const toInput = screen.getByLabelText("To");
    fireEvent.change(toInput, { target: { value: "recipient@example.com" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    const subjectInput = screen.getByLabelText("Subject");
    fireEvent.change(subjectInput, { target: { value: "Test subject" } });

    const sendButton = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(commands.saveDraft).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(commands.enqueueSend).toHaveBeenCalledWith(1);
    });

    const saveDraftOrder = (commands.saveDraft as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const enqueueSendOrder = (commands.enqueueSend as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(saveDraftOrder).toBeLessThan(enqueueSendOrder);
  });

  it("passes html_body from editor getHTML to saveDraft", async () => {
    const { commands } = await import("../../ipc/bindings");

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    const sendButton = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(commands.saveDraft).toHaveBeenCalled();
    });

    const callArgs = (commands.saveDraft as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = callArgs[2];
    expect(message.html_body).toBe("<p>Hello world</p>");
    expect(message.text_body).toBe("Hello world");
  });

  it("does not render when composer is closed", async () => {
    useUiStore.setState({ composer: { open: false, draftId: null } });

    render(<Composer />, { wrapper: Wrapper });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
