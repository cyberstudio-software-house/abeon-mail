import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listThreadMessages: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    getMessageBody: vi.fn().mockResolvedValue({ status: "ok", data: { message_id: 1, text_plain: null, text_html: null } }),
    markMessageSeen: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
  events: {},
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

import { useUiStore } from "../../app/store";
import { ReaderPane } from "./ReaderPane";

const mockUseUiStore = vi.mocked(useUiStore);

function setupStore(selectedThreadId: number | null) {
  mockUseUiStore.mockImplementation((selector: (s: any) => unknown) => {
    const state = {
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId,
      density: "comfortable",
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedThreadId: vi.fn(),
      setDensity: vi.fn(),
      setReplyTargetId: vi.fn(),
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

  it("shows empty state when no thread selected", () => {
    setupStore(null);

    render(<ReaderPane />, { wrapper: Wrapper });

    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/select a conversation/i)).toBeTruthy();
  });

  it("renders conversation view when thread is selected", async () => {
    setupStore(1);

    render(<ReaderPane />, { wrapper: Wrapper });

    expect(screen.getByLabelText("reader")).toBeTruthy();
  });
});
