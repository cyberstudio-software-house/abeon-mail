import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SignaturesSection } from "./SignaturesSection";
import { commands } from "../../ipc/bindings";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listAccounts: vi.fn().mockResolvedValue({
      status: "ok",
      data: [
        { id: 7, email: "me@example.com", display_name: "Me", provider_type: "imap_password", color: null, position: 0, requires_reauth: false },
        { id: 8, email: "other@example.com", display_name: "Other", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
      ],
    }),
    listSignatures: vi.fn(),
    createSignature: vi.fn().mockResolvedValue({ status: "ok", data: { id: 3, name: "New", html: "<p></p>", is_default: false } }),
    updateSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    setDefaultSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    deleteSignature: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

vi.mock("@tiptap/react", () => {
  const editorInstance = {
    getHTML: () => "<p>edited</p>",
    commands: { setContent: vi.fn(), focus: vi.fn() },
    destroy: vi.fn(),
  };
  return {
    useEditor: () => editorInstance,
    EditorContent: () => <div data-testid="signature-editor" />,
  };
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("SignaturesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [
        { id: 1, name: "Work", html: "<p>BR</p>", is_default: true, is_html: false },
        { id: 2, name: "Casual", html: "<p>Cheers</p>", is_default: false, is_html: false },
      ],
    });
  });
  afterEach(() => cleanup());

  it("lists signatures for the first account", async () => {
    const { getByText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    expect(getByText("Casual")).toBeTruthy();
  });

  it("creates a new signature", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByText("New signature"));
    fireEvent.change(getByLabelText("Signature name"), { target: { value: "Holiday" } });
    fireEvent.click(getByText("Save signature"));
    await waitFor(() =>
      expect(commands.createSignature).toHaveBeenCalledWith(7, "Holiday", "<p>edited</p>", false, false),
    );
  });

  it("saves a raw HTML signature with is_html=true", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByText("New signature"));
    fireEvent.change(getByLabelText("Signature name"), { target: { value: "HtmlSig" } });
    fireEvent.click(getByText("Edit HTML source"));
    fireEvent.change(getByLabelText("Signature HTML source"), {
      target: { value: "<table><tr><td>Hi</td></tr></table>" },
    });
    fireEvent.click(getByText("Save signature"));
    await waitFor(() =>
      expect(commands.createSignature).toHaveBeenCalledWith(
        7,
        "HtmlSig",
        "<table><tr><td>Hi</td></tr></table>",
        false,
        true,
      ),
    );
  });

  it("opens an existing HTML signature in HTML source mode", async () => {
    (commands.listSignatures as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [{ id: 5, name: "Fancy", html: "<table>FANCY</table>", is_default: true, is_html: true }],
    });
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Fancy")).toBeTruthy());
    fireEvent.click(getByText("Fancy"));
    const textarea = getByLabelText("Signature HTML source") as HTMLTextAreaElement;
    expect(textarea.value).toBe("<table>FANCY</table>");
  });

  it("sets a non-default signature as default", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByLabelText("Set Casual as default"));
    await waitFor(() => expect(commands.setDefaultSignature).toHaveBeenCalledWith(7, 2));
  });

  it("deletes a signature", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByLabelText("Delete signature Casual"));
    await waitFor(() => expect(commands.deleteSignature).toHaveBeenCalledWith(2));
  });

  it("reloads signatures when the account changes", async () => {
    const { getByText, getByLabelText } = wrap(<SignaturesSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.change(getByLabelText("Signatures account"), { target: { value: "8" } });
    await waitFor(() => expect(commands.listSignatures).toHaveBeenCalledWith(8));
  });
});
