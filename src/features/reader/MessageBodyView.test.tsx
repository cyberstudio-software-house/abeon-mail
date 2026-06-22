import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
