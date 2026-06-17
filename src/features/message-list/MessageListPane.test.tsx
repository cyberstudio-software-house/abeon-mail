import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mockSetSelectedThreadId = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useThreads: vi.fn(),
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

import { useThreads } from "../../ipc/queries";
import { useUiStore, type Density } from "../../app/store";
import { MessageListPane } from "./MessageListPane";
import type { ThreadSummary } from "../../ipc/bindings";

type UiState = {
  selectedAccountId: number | null;
  selectedFolderId: number | null;
  selectedMessageId: number | null;
  selectedThreadId: number | null;
  density: Density;
  composer: { open: boolean; draftId: number | null };
  setSelectedAccountId: (id: number | null) => void;
  setSelectedFolderId: (id: number | null) => void;
  setSelectedMessageId: (id: number | null) => void;
  setSelectedThreadId: (id: number | null) => void;
  setDensity: (density: Density) => void;
  openComposer: (draftId: number | null) => void;
  closeComposer: () => void;
};

const mockUseThreads = vi.mocked(useThreads);
const mockUseUiStore = vi.mocked(useUiStore);

const sampleThreads: ThreadSummary[] = [
  {
    thread_id: 1,
    account_id: 1,
    subject: "Hello World",
    last_date: 1700000000,
    message_count: 2,
    unread_count: 1,
    participants: ["Alice Smith", "Bob Jones"],
    snippet: "Hello there",
    has_attachments: false,
    flagged: false,
  },
  {
    thread_id: 2,
    account_id: 1,
    subject: "Second thread",
    last_date: 1700001000,
    message_count: 1,
    unread_count: 0,
    participants: ["Carol"],
    snippet: "Second snippet",
    has_attachments: true,
    flagged: true,
  },
];

function setupStore(selectedFolderId: number | null, density: Density = "comfortable") {
  mockUseUiStore.mockImplementation((selector: (s: UiState) => unknown) => {
    const state: UiState = {
      selectedAccountId: null,
      selectedFolderId,
      selectedMessageId: null,
      selectedThreadId: null,
      density,
      composer: { open: false, draftId: null },
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedMessageId: vi.fn(),
      setSelectedThreadId: mockSetSelectedThreadId,
      setDensity: vi.fn(),
      openComposer: vi.fn(),
      closeComposer: vi.fn(),
    };
    return selector ? selector(state) : state;
  });
}

describe("MessageListPane", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 600,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 400,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders thread list with participants and subject visible, clicking row calls setSelectedThreadId", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: sampleThreads,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);

    render(<MessageListPane />);

    expect(screen.getByLabelText("message-list")).toBeTruthy();
    expect(screen.getByText("Alice Smith, Bob Jones")).toBeTruthy();
    expect(screen.getByText("Hello World")).toBeTruthy();

    const firstRow = screen.getByText("Hello World").closest("[data-thread-id]");
    expect(firstRow).toBeTruthy();
    fireEvent.click(firstRow!);
    expect(mockSetSelectedThreadId).toHaveBeenCalledWith(1);
  });

  it("shows select-folder empty state when selectedFolderId is null", () => {
    setupStore(null);
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);

    render(<MessageListPane />);

    expect(screen.getByText(/select a folder/i)).toBeTruthy();
  });

  it("shows no-messages empty state when folder is selected but has 0 threads", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);

    render(<MessageListPane />);

    expect(screen.getByText(/no messages/i)).toBeTruthy();
  });

  it("shows loading skeleton when isLoading", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);

    render(<MessageListPane />);

    const skeletons = document.querySelectorAll(".skeleton-row");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
