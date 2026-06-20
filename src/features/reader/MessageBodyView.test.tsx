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
    markMessageSeen: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

import { MessageBodyView } from "./MessageBodyView";

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

describe("MessageBodyView — HTML body path", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders a sandboxed iframe via SafeHtmlFrame when text_html is present", async () => {
    render(<MessageBodyView messageId={42} shouldMarkSeen={true} />, { wrapper: Wrapper });

    const iframe = await waitFor(() => {
      const el = screen.getByTitle("message-content");
      return el;
    });

    expect(iframe.tagName.toLowerCase()).toBe("iframe");
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("does not call markMessageSeen when shouldMarkSeen is false", async () => {
    const { commands } = await import("../../ipc/bindings");
    render(<MessageBodyView messageId={42} shouldMarkSeen={false} />, { wrapper: Wrapper });

    await screen.findByTitle("message-content");

    expect(commands.markMessageSeen).not.toHaveBeenCalled();
  });
});
