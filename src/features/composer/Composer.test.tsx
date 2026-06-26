import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react";
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
    discardDraft: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

let mockHtmlContent = "<p>Hello world</p>";

const { mockSetContent } = vi.hoisted(() => ({ mockSetContent: vi.fn() }));

vi.mock("@tiptap/react", () => {
  const editorInstance = {
    isActive: () => false,
    getText: () => "Hello world",
    getHTML: () => mockHtmlContent,
    commands: { setContent: mockSetContent, focus: vi.fn() },
    chain: () => ({
      focus: () => ({
        toggleBold: () => ({ run: vi.fn() }),
        toggleItalic: () => ({ run: vi.fn() }),
        toggleBulletList: () => ({ run: vi.fn() }),
        setLink: () => ({ run: vi.fn() }),
        insertContent: () => ({ run: vi.fn() }),
        setImage: ({ src }: { src: string }) => ({
          run: () => {
            mockHtmlContent = `<p>Hello world</p><img src="${src}">`;
          },
        }),
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
    useUiStore.setState({ composer: { open: true, draftId: null, prefill: null } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useUiStore.setState({
      composer: { open: false, draftId: null, prefill: null },
      selectedAccountId: null,
    });
    mockHtmlContent = "<p>Hello world</p>";
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
    useUiStore.setState({ composer: { open: false, draftId: null, prefill: null } });

    render(<Composer />, { wrapper: Wrapper });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows send error when enqueueSend fails", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.enqueueSend as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "error",
      error: "SMTP connection failed",
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    const sendButton = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toContain("SMTP connection failed");
  });

  it("calls discardDraft with saved draftId when Discard is clicked after autosave", async () => {
    const { commands } = await import("../../ipc/bindings");

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");
    await screen.findByDisplayValue("me@example.com", { exact: false });

    vi.useFakeTimers();

    const subjectInput = screen.getByLabelText("Subject");
    fireEvent.change(subjectInput, { target: { value: "draft subject" } });

    expect(commands.saveDraft).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.useRealTimers();

    expect(commands.saveDraft).toHaveBeenCalled();

    const discardButton = screen.getByRole("button", { name: "Discard" });
    await act(async () => {
      fireEvent.click(discardButton);
    });

    await waitFor(() => {
      expect(commands.discardDraft).toHaveBeenCalledWith(1);
    });
  });

  it("autosave calls saveDraft after field edit with debounce delay", async () => {
    const { commands } = await import("../../ipc/bindings");

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");
    await screen.findByDisplayValue("me@example.com", { exact: false });

    vi.useFakeTimers();

    const subjectInput = screen.getByLabelText("Subject");
    fireEvent.change(subjectInput, { target: { value: "autosave test" } });

    expect(commands.saveDraft).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.useRealTimers();

    expect(commands.saveDraft).toHaveBeenCalled();
  });

  const emptyPrefill = {
    from_address: "",
    from_name: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    text_body: "",
    html_body: null,
    in_reply_to: null,
    references: [],
    attachments: [],
  };

  it("auto-inserts the default signature above the quote on a fresh reply", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 1, name: "Default", html: "<p>SIG-MARK</p>", is_default: true }],
    });
    useUiStore.setState({
      composer: {
        open: true,
        draftId: null,
        prefill: { ...emptyPrefill, html_body: "<blockquote>QUOTED</blockquote>" },
      },
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    await waitFor(() => {
      const call = mockSetContent.mock.calls.find((c) => String(c[0]).includes("SIG-MARK"));
      expect(call).toBeTruthy();
    });
    const call = mockSetContent.mock.calls.find((c) => String(c[0]).includes("SIG-MARK"));
    const content = String(call?.[0]);
    expect(content).toContain("QUOTED");
    expect(content.indexOf("SIG-MARK")).toBeLessThan(content.indexOf("QUOTED"));
  });

  it("does not auto-insert a signature when reopening an existing draft", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 1, name: "Default", html: "<p>SIG-MARK</p>", is_default: true }],
    });
    useUiStore.setState({
      composer: {
        open: true,
        draftId: 42,
        prefill: { ...emptyPrefill, html_body: "<p>existing draft body</p>" },
      },
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sigCall = mockSetContent.mock.calls.find((c) => String(c[0]).includes("SIG-MARK"));
    expect(sigCall).toBeUndefined();
  });

  it("shows a signature picker when the account has signatures", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [
        { id: 1, name: "Default", html: "<p>BR</p>", is_default: true },
        { id: 2, name: "Casual", html: "<p>Cheers</p>", is_default: false },
      ],
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    const picker = await screen.findByLabelText("Insert signature");
    expect(within(picker).getByText("Casual")).toBeTruthy();
  });

  it("rewrites inline image src to cid: in html_body and includes inline attachment on Send", async () => {
    const { commands } = await import("../../ipc/bindings");

    const inlineAttachment = {
      filename: "photo.jpg",
      mime_type: "image/jpeg",
      blob_ref: "/tmp/photo.jpg",
      content_id: "inline-1@abeonmail",
    };

    (commands.pickAttachment as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "ok",
      data: [inlineAttachment],
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    const insertImageButton = screen.getByRole("button", { name: "Wstaw obraz" });
    await act(async () => {
      fireEvent.click(insertImageButton);
    });

    await waitFor(() => {
      expect(commands.pickAttachment).toHaveBeenCalled();
    });

    const sendButton = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(commands.saveDraft).toHaveBeenCalled();
    });

    const callArgs = (commands.saveDraft as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = callArgs[2];

    expect(message.html_body).toContain("cid:inline-1@abeonmail");
    expect(message.html_body).not.toContain('src="/tmp/photo.jpg"');
    expect(message.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content_id: "inline-1@abeonmail", blob_ref: "/tmp/photo.jpg" }),
      ])
    );
  });

  it("does NOT inject an HTML signature into the editor, but appends it to html_body only on Send", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 9, name: "Fancy", html: "<table>HTML-SIG</table>", is_default: true, is_html: true }],
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    await screen.findByText("Signature preview");
    const injected = mockSetContent.mock.calls.find((c) => String(c[0]).includes("HTML-SIG"));
    expect(injected).toBeUndefined();

    const sendButton = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(commands.saveDraft).toHaveBeenCalled();
    });
    const message = (commands.saveDraft as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(message.html_body).toContain("<table>HTML-SIG</table>");
    expect(message.html_body.indexOf("Hello world")).toBeLessThan(message.html_body.indexOf("HTML-SIG"));
  });

  it("does NOT append the HTML signature on autosave/draft save", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 9, name: "Fancy", html: "<table>HTML-SIG</table>", is_default: true, is_html: true }],
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");
    await screen.findByText("Signature preview");

    const saveDraftButton = await screen.findByRole("button", { name: "Save draft" });
    fireEvent.click(saveDraftButton);

    await waitFor(() => {
      expect(commands.saveDraft).toHaveBeenCalled();
    });
    const message = (commands.saveDraft as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(message.html_body).not.toContain("HTML-SIG");
  });

  it("renders a sandboxed preview iframe for an active HTML signature", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 9, name: "Fancy", html: "<table>HTML-SIG</table>", is_default: true, is_html: true }],
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    const toggle = await screen.findByRole("button", { name: "Signature preview" });
    fireEvent.click(toggle);

    const frame = await screen.findByTitle("signature-preview");
    expect(frame.getAttribute("sandbox")).toBe("");
  });

  it("removes the HTML signature when the user clicks Remove, omitting it from Send", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 9, name: "Fancy", html: "<table>HTML-SIG</table>", is_default: true, is_html: true }],
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");
    await screen.findByText("Signature preview");

    const removeButton = await screen.findByRole("button", { name: "Remove signature" });
    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(screen.queryByTitle("signature-preview")).toBeNull();
    });

    const sendButton = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(commands.saveDraft).toHaveBeenCalled();
    });
    const message = (commands.saveDraft as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(message.html_body).not.toContain("HTML-SIG");
  });

  const twoAccounts = [
    { id: 7, email: "first@example.com", display_name: "First", provider_type: "imap_password", color: null, position: 0 },
    { id: 9, email: "active@example.com", display_name: "Active", provider_type: "imap_password", color: null, position: 1 },
  ];

  it("defaults the From account to the active account for a new message", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listAccounts as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", data: twoAccounts });
    useUiStore.setState({
      composer: { open: true, draftId: null, prefill: null },
      selectedAccountId: 9,
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    const fromSelect = (await screen.findByLabelText("From account")) as HTMLSelectElement;
    await waitFor(() => {
      expect(fromSelect.value).toBe("9");
    });
  });

  it("falls back to the first account for a new message when no account is active", async () => {
    const { commands } = await import("../../ipc/bindings");
    (commands.listAccounts as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok", data: twoAccounts });
    useUiStore.setState({
      composer: { open: true, draftId: null, prefill: null },
      selectedAccountId: null,
    });

    render(<Composer />, { wrapper: Wrapper });
    await screen.findByRole("dialog");

    const fromSelect = (await screen.findByLabelText("From account")) as HTMLSelectElement;
    await waitFor(() => {
      expect(fromSelect.value).toBe("7");
    });
  });
});
