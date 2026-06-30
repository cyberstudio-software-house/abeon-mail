import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSetContentSecurityLevel } from "../../ipc/queries";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getMessageBody: vi.fn().mockResolvedValue({
      status: "ok",
      data: { message_id: 42, text_plain: null, text_html: "<p>hi</p>" },
    }),
    renderMessageHtml: vi.fn().mockResolvedValue({
      status: "ok",
      data: { html: "<p>safe</p>", blocked_remote_content: false, remote_loaded: false },
    }),
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    openExternalUrl: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

import { MessageBodyView } from "./MessageBodyView";
import { commands } from "../../ipc/bindings";

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>;
}

describe("MessageBodyView — HTML body path", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("re-renders with remote content when the level changes to open while open", async () => {
    let currentLevel = "balanced";
    (commands.getSettings as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ status: "ok", data: [["reader.contentSecurity", currentLevel]] })
    );
    (commands.setSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string, value: string) => {
      if (key === "reader.contentSecurity") currentLevel = value;
      return Promise.resolve({ status: "ok", data: null });
    });

    function Harness() {
      const setLevel = useSetContentSecurityLevel();
      return (
        <>
          <button type="button" onClick={() => setLevel.mutate("open")}>
            go-open
          </button>
          <MessageBodyView messageId={42} />
        </>
      );
    }

    render(<Harness />, { wrapper: Wrapper });

    await waitFor(() => expect(commands.renderMessageHtml).toHaveBeenCalledWith(42, false));

    fireEvent.click(screen.getByText("go-open"));

    await waitFor(() => expect(commands.renderMessageHtml).toHaveBeenCalledWith(42, true));
  });

  it("auto-loads remote content at the open level", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "open"]],
    });
    render(<MessageBodyView messageId={42} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(commands.renderMessageHtml).toHaveBeenCalledWith(42, true);
    });
  });

  it("uses a fully locked iframe at the strict level", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "strict"]],
    });
    render(<MessageBodyView messageId={42} />, { wrapper: Wrapper });

    await waitFor(() => {
      const el = screen.getByTitle("message-content");
      expect(el.getAttribute("sandbox")).toBe("");
    });
  });

  it("relaxes the iframe to same-origin (never scripts) at the balanced level", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "balanced"]],
    });
    render(<MessageBodyView messageId={42} />, { wrapper: Wrapper });

    await waitFor(() => {
      const el = screen.getByTitle("message-content");
      expect(el.getAttribute("sandbox")).toBe(
        "allow-same-origin allow-top-navigation-by-user-activation"
      );
    });
    expect(screen.getByTitle("message-content").getAttribute("sandbox")).not.toContain("allow-scripts");
  });
});

describe("MessageBodyView — quoted history collapse", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("collapses HTML history by default and expands on click", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "balanced"]],
    });
    (commands.renderMessageHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: {
        html:
          "<div>Visible reply</div>" +
          '<div class="gmail_quote"><div class="gmail_attr">On Mon wrote:</div>' +
          "<blockquote>hidden history</blockquote></div>",
        blocked_remote_content: false,
        remote_loaded: false,
      },
    });

    render(<MessageBodyView messageId={7} />, { wrapper: Wrapper });

    const frame = await screen.findByTitle("message-content");
    expect(frame.getAttribute("srcdoc")).toContain("Visible reply");
    expect(frame.getAttribute("srcdoc")).not.toContain("hidden history");

    fireEvent.click(screen.getByRole("button", { name: "Pokaż cytowaną historię" }));

    await waitFor(() =>
      expect(screen.getByTitle("message-content").getAttribute("srcdoc")).toContain("hidden history")
    );
  });

  it("shows no toggle when the HTML has no quoted history", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "balanced"]],
    });
    (commands.renderMessageHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: { html: "<p>No quotes here</p>", blocked_remote_content: false, remote_loaded: false },
    });

    render(<MessageBodyView messageId={8} />, { wrapper: Wrapper });

    await screen.findByTitle("message-content");
    expect(screen.queryByRole("button", { name: /cytowaną historię/ })).toBeNull();
  });

  it("collapses plain-text history by default and expands on click", async () => {
    (commands.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [["reader.contentSecurity", "balanced"]],
    });
    (commands.renderMessageHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: { html: null, blocked_remote_content: false, remote_loaded: false },
    });
    (commands.getMessageBody as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: {
        message_id: 9,
        text_plain: "Visible reply text\n\n> hidden quoted line",
        text_html: null,
      },
    });

    render(<MessageBodyView messageId={9} />, { wrapper: Wrapper });

    await screen.findByText((t) => t.includes("Visible reply text"));
    expect(screen.queryByText((t) => t.includes("hidden quoted line"))).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pokaż cytowaną historię" }));

    await screen.findByText((t) => t.includes("hidden quoted line"));
  });
});
