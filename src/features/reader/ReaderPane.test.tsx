import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../ipc/queries", () => ({
  useMessageBody: vi.fn(),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    sanitizeMessageHtml: vi.fn(),
  },
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

import { useMessageBody } from "../../ipc/queries";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { ReaderPane } from "./ReaderPane";
import type { MessageBody } from "../../ipc/bindings";

const mockUseMessageBody = vi.mocked(useMessageBody);
const mockSanitize = vi.mocked(commands.sanitizeMessageHtml);
const mockUseUiStore = vi.mocked(useUiStore);

function setupStore(selectedMessageId: number | null) {
  mockUseUiStore.mockImplementation((selector: (s: any) => unknown) => {
    const state = {
      selectedAccountId: null,
      selectedFolderId: null,
      selectedMessageId,
      density: "comfortable",
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedMessageId: vi.fn(),
      setDensity: vi.fn(),
    };
    return selector ? selector(state) : state;
  });
}

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

describe("ReaderPane", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows empty state when no message selected", () => {
    setupStore(null);
    mockUseMessageBody.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as ReturnType<typeof useMessageBody>);

    render(<ReaderPane />, { wrapper: Wrapper });

    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/select a message/i)).toBeTruthy();
  });

  it("renders iframe and remote-content banner when blocked_remote_content is true", async () => {
    setupStore(1);
    mockUseMessageBody.mockReturnValue({
      data: {
        message_id: 1,
        text_html: "<p>x</p>",
        text_plain: null,
      } as MessageBody,
      isLoading: false,
    } as ReturnType<typeof useMessageBody>);
    mockSanitize.mockResolvedValue({ html: "<p>x</p>", blocked_remote_content: true });

    render(<ReaderPane />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(document.querySelector("iframe")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText(/load images/i)).toBeTruthy();
    });
  });

  it("renders iframe without banner when blocked_remote_content is false", async () => {
    setupStore(1);
    mockUseMessageBody.mockReturnValue({
      data: {
        message_id: 1,
        text_html: "<p>x</p>",
        text_plain: null,
      } as MessageBody,
      isLoading: false,
    } as ReturnType<typeof useMessageBody>);
    mockSanitize.mockResolvedValue({ html: "<p>x</p>", blocked_remote_content: false });

    render(<ReaderPane />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(document.querySelector("iframe")).toBeTruthy();
    });

    expect(screen.queryByText(/load images/i)).toBeNull();
  });

  it("renders plain text in pre without iframe for text-only messages", async () => {
    setupStore(1);
    mockUseMessageBody.mockReturnValue({
      data: {
        message_id: 1,
        text_html: null,
        text_plain: "hello world",
      } as MessageBody,
      isLoading: false,
    } as ReturnType<typeof useMessageBody>);

    render(<ReaderPane />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText("hello world")).toBeTruthy();
    });

    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("pre")).toBeTruthy();
  });

  it("shows loading state while fetching body", () => {
    setupStore(1);
    mockUseMessageBody.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useMessageBody>);

    render(<ReaderPane />, { wrapper: Wrapper });

    expect(screen.getByText(/loading/i)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("sanitizes html and prevents raw html from reaching iframe", async () => {
    setupStore(1);
    mockUseMessageBody.mockReturnValue({
      data: {
        message_id: 1,
        text_html: "<p>RAW</p>",
        text_plain: null,
      } as MessageBody,
      isLoading: false,
    } as ReturnType<typeof useMessageBody>);
    mockSanitize.mockResolvedValue({ html: "<p>SAFE</p>", blocked_remote_content: false });

    const { container } = render(<ReaderPane />, { wrapper: Wrapper });

    await waitFor(() => {
      const iframe = container.querySelector("iframe");
      expect(iframe).toBeTruthy();
    });

    const iframe = container.querySelector("iframe");
    const srcdoc = iframe?.getAttribute("srcdoc");
    expect(srcdoc).toContain("<p>SAFE</p>");
    expect(srcdoc).not.toContain("<p>RAW</p>");
  });
});
