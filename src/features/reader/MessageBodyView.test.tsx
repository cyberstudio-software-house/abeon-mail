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
      expect(el.getAttribute("sandbox")).toBe("allow-same-origin");
    });
    expect(screen.getByTitle("message-content").getAttribute("sandbox")).not.toContain("allow-scripts");
  });
});
