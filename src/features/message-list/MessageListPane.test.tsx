import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mockSetSelectedMessageId = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useMessages: vi.fn(),
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

import { useMessages } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { MessageListPane } from "./MessageListPane";
import type { MessageHeader } from "../../ipc/bindings";

type Density = "comfortable" | "cozy" | "compact" | "dense";

type UiState = {
  selectedAccountId: number | null;
  selectedFolderId: number | null;
  selectedMessageId: number | null;
  density: Density;
  setSelectedAccountId: (id: number | null) => void;
  setSelectedFolderId: (id: number | null) => void;
  setSelectedMessageId: (id: number | null) => void;
  setDensity: (density: Density) => void;
};

const mockUseMessages = vi.mocked(useMessages);
const mockUseUiStore = vi.mocked(useUiStore);

const sampleMessages: MessageHeader[] = [
  {
    id: 1,
    account_id: 1,
    folder_id: 10,
    subject: "Hello World",
    from_address: "alice@example.com",
    from_name: "Alice Smith",
    date: 1700000000,
    seen: false,
    flagged: false,
    has_attachments: false,
    snippet: "Hello there",
  },
  {
    id: 2,
    account_id: 1,
    folder_id: 10,
    subject: "Second message",
    from_address: "bob@example.com",
    from_name: "Bob Jones",
    date: 1700001000,
    seen: true,
    flagged: true,
    has_attachments: true,
    snippet: "Second snippet",
  },
  {
    id: 3,
    account_id: 1,
    folder_id: 10,
    subject: "Third subject",
    from_address: "carol@example.com",
    from_name: null,
    date: 1700002000,
    seen: true,
    flagged: false,
    has_attachments: false,
    snippet: "Third snippet",
  },
  {
    id: 4,
    account_id: 1,
    folder_id: 10,
    subject: "Fourth subject",
    from_address: "dave@example.com",
    from_name: "Dave",
    date: 1700003000,
    seen: false,
    flagged: false,
    has_attachments: false,
    snippet: "Fourth snippet",
  },
  {
    id: 5,
    account_id: 1,
    folder_id: 10,
    subject: "Fifth subject",
    from_address: "eve@example.com",
    from_name: "Eve",
    date: 1700004000,
    seen: true,
    flagged: true,
    has_attachments: true,
    snippet: "Fifth snippet",
  },
];

function setupStore(selectedFolderId: number | null, density: Density = "comfortable") {
  mockUseUiStore.mockImplementation((selector: (s: UiState) => unknown) => {
    const state: UiState = {
      selectedAccountId: null,
      selectedFolderId,
      selectedMessageId: null,
      density,
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedMessageId: mockSetSelectedMessageId,
      setDensity: vi.fn(),
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

  it("renders message list with first subject visible and clicking row calls setSelectedMessageId", () => {
    setupStore(10);
    mockUseMessages.mockReturnValue({
      data: sampleMessages,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useMessages>);

    render(<MessageListPane />);

    expect(screen.getByLabelText("message-list")).toBeTruthy();
    expect(screen.getByText("Hello World")).toBeTruthy();

    const firstRow = screen.getByText("Hello World").closest("[data-message-id]");
    expect(firstRow).toBeTruthy();
    fireEvent.click(firstRow!);
    expect(mockSetSelectedMessageId).toHaveBeenCalledWith(1);
  });

  it("shows select-folder empty state when selectedFolderId is null", () => {
    setupStore(null);
    mockUseMessages.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useMessages>);

    render(<MessageListPane />);

    expect(screen.getByText(/select a folder/i)).toBeTruthy();
  });

  it("shows no-messages empty state when folder is selected but has 0 messages", () => {
    setupStore(10);
    mockUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useMessages>);

    render(<MessageListPane />);

    expect(screen.getByText(/no messages/i)).toBeTruthy();
  });

  it("shows loading skeleton when isLoading", () => {
    setupStore(10);
    mockUseMessages.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useMessages>);

    render(<MessageListPane />);

    const skeletons = document.querySelectorAll(".skeleton-row");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
