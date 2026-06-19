import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mockOpenComposer = vi.fn();

const mockSetSelectedThreadId = vi.fn();
const mockSetSelectedMessageId = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useThreads: vi.fn(),
  useSmartFolder: vi.fn(),
  useSearch: vi.fn(),
  useMessagesByLabel: (id: number | null) =>
    id === 1
      ? { data: [{ message_id: 99, account_id: 1, folder_id: 1, account_color: "#4f46e5", from_address: "a@b.com", from_name: "A", subject: "Tagged", date: 1000, seen: true, flagged: false, has_attachments: false, snippet: "" }], isLoading: false }
      : { data: undefined, isLoading: false },
  useLabels: () => ({ data: [{ id: 1, name: "Work", color: "#4f46e5" }] }),
  useLabelsForMessages: () => ({ data: [] }),
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

import { useThreads, useSmartFolder, useSearch } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import type { UiState, Density } from "../../app/store";
import { MessageListPane } from "./MessageListPane";
import type { ThreadSummary, SmartMessageRow } from "../../ipc/bindings";

const mockUseThreads = vi.mocked(useThreads);
const mockUseSmartFolder = vi.mocked(useSmartFolder);
const mockUseSearch = vi.mocked(useSearch);
const mockUseUiStore = vi.mocked(useUiStore);

const nowSeconds = Math.floor(Date.now() / 1000);
const todaySeconds = nowSeconds - 3600;
const yesterdaySeconds = nowSeconds - 86400 - 3600;
const earlierSeconds = nowSeconds - 86400 * 3;

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

const groupedThreads: ThreadSummary[] = [
  {
    thread_id: 10,
    account_id: 1,
    subject: "Today Thread",
    last_date: todaySeconds,
    message_count: 1,
    unread_count: 0,
    participants: ["Today Sender"],
    snippet: "Today snippet",
    has_attachments: false,
    flagged: false,
  },
  {
    thread_id: 11,
    account_id: 1,
    subject: "Yesterday Thread",
    last_date: yesterdaySeconds,
    message_count: 1,
    unread_count: 0,
    participants: ["Yesterday Sender"],
    snippet: "Yesterday snippet",
    has_attachments: false,
    flagged: false,
  },
  {
    thread_id: 12,
    account_id: 1,
    subject: "Earlier Thread",
    last_date: earlierSeconds,
    message_count: 1,
    unread_count: 0,
    participants: ["Earlier Sender"],
    snippet: "Earlier snippet",
    has_attachments: false,
    flagged: false,
  },
];

const sampleSmartRows: SmartMessageRow[] = [
  {
    message_id: 100,
    account_id: 1,
    folder_id: 10,
    account_color: "#ff0000",
    from_address: "alice@example.com",
    from_name: "Alice",
    subject: "Smart Inbox Subject",
    date: 1700000000,
    seen: false,
    flagged: false,
    has_attachments: false,
    snippet: "Smart preview",
  },
  {
    message_id: 101,
    account_id: 2,
    folder_id: 20,
    account_color: "#00ff00",
    from_address: "bob@example.com",
    from_name: null,
    subject: "Another Smart Subject",
    date: 1700001000,
    seen: true,
    flagged: false,
    has_attachments: false,
    snippet: "Another preview",
  },
];

function setupStore(
  selectedFolderId: number | null,
  density: Density = "comfortable",
  selectedSmartFolder: UiState["selectedSmartFolder"] = null,
  searchActive = false,
  searchQuery = "",
  selectedLabelId: number | null = null
) {
  mockUseUiStore.mockImplementation((selector: (s: UiState) => unknown) => {
    const state: UiState = {
      selectedAccountId: null,
      selectedFolderId,
      selectedMessageId: null,
      selectedThreadId: null,
      selectedSmartFolder,
      selectedLabelId,
      theme: "auto",
      accent: "#4f46e5",
      density,
      showPreview: true,
      showAvatars: true,
      composer: { open: false, draftId: null, prefill: null },
      setSelectedAccountId: vi.fn(),
      setSelectedFolderId: vi.fn(),
      setSelectedMessageId: mockSetSelectedMessageId,
      setSelectedThreadId: mockSetSelectedThreadId,
      setSelectedSmartFolder: vi.fn(),
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      setDensity: vi.fn(),
      setShowPreview: vi.fn(),
      setShowAvatars: vi.fn(),
      hydrateAppearance: vi.fn(),
      settingsOpen: false,
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      openComposer: mockOpenComposer,
      closeComposer: vi.fn(),
      visibleMessageIds: [],
      selectMode: "thread",
      replyTargetId: null,
      composerSend: null,
      paletteOpen: false,
      cheatSheetOpen: false,
      shortcutProfile: "default",
      shortcutOverrides: {},
      searchQuery,
      searchActive,
      focusSearch: null,
      setListContext: vi.fn(),
      setReplyTargetId: vi.fn(),
      setComposerSend: vi.fn(),
      togglePalette: vi.fn(),
      closePalette: vi.fn(),
      toggleCheatSheet: vi.fn(),
      closeCheatSheet: vi.fn(),
      setShortcutProfile: vi.fn(),
      setShortcutOverride: vi.fn(),
      resetShortcut: vi.fn(),
      hydrateShortcuts: vi.fn(),
      setSearchQuery: vi.fn(),
      clearSearch: vi.fn(),
      setFocusSearch: vi.fn(),
    };
    return selector ? selector(state) : state;
  });
}

function renderPane() {
  return render(<MessageListPane />);
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
    mockUseSearch.mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useSearch>);
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
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    expect(screen.getByLabelText("message-list")).toBeTruthy();
    expect(screen.getByText("Alice Smith, Bob Jones")).toBeTruthy();
    expect(screen.getByText("Hello World")).toBeTruthy();

    const firstRow = screen.getByText("Hello World").closest("[data-thread-id]");
    expect(firstRow).toBeTruthy();
    fireEvent.click(firstRow!);
    expect(mockSetSelectedThreadId).toHaveBeenCalledWith(1);
  });

  it("shows select-folder empty state when selectedFolderId and selectedSmartFolder are both null", () => {
    setupStore(null, "comfortable", null);
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

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
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

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
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    const skeletons = document.querySelectorAll(".skeleton-row");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders smart folder rows with account colour dots when selectedSmartFolder is set", () => {
    setupStore(null, "comfortable", "all_inboxes");
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: sampleSmartRows,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    expect(screen.getByText("Smart Inbox Subject")).toBeTruthy();
    expect(screen.getByText("Another Smart Subject")).toBeTruthy();

    const dots = document.querySelectorAll("[data-account-dot]");
    expect(dots.length).toBe(2);
    expect((dots[0] as HTMLElement).style.background).toBe("#ff0000");
    expect((dots[1] as HTMLElement).style.background).toBe("#00ff00");
  });

  it("clicking a smart row calls setSelectedMessageId", () => {
    setupStore(null, "comfortable", "all_inboxes");
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: sampleSmartRows,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    const firstRow = screen.getByText("Smart Inbox Subject").closest("[data-message-id]");
    expect(firstRow).toBeTruthy();
    fireEvent.click(firstRow!);
    expect(mockSetSelectedMessageId).toHaveBeenCalledWith(100);
  });

  it("renders date group headers", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: groupedThreads,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.getByText("Earlier")).toBeTruthy();
  });

  it("Compose button in list header opens composer", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: sampleThreads,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    const composeBtn = screen.getByRole("button", { name: "New message" });
    fireEvent.click(composeBtn);
    expect(mockOpenComposer).toHaveBeenCalledWith(null);
  });

  it("sort label is a non-interactive placeholder", () => {
    setupStore(10);
    mockUseThreads.mockReturnValue({
      data: sampleThreads,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    render(<MessageListPane />);

    const newestEl = screen.getByText("Newest", { exact: false });
    const ariaDisabledEl = newestEl.closest("[aria-disabled='true']");
    expect(ariaDisabledEl).toBeTruthy();
  });

  it("renders label-view messages when a label is selected", () => {
    setupStore(null, "comfortable", null, false, "", 1);
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);
    const { getByText } = renderPane();
    expect(getByText(/Label: Work/)).toBeTruthy();
  });

  it("shows a results banner and highlighted rows in search mode", () => {
    mockUseSearch.mockReturnValue({
      data: [
        {
          message_id: 1,
          account_id: 1,
          folder_id: 1,
          account_color: "#ff0000",
          from_address: "alice@example.com",
          from_name: "Alice",
          subject: "Quarterly report",
          date: 1000,
          seen: true,
          flagged: false,
          has_attachments: false,
          snippet: "the report is ready",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useSearch>);

    setupStore(null, "comfortable", null, true, "report");
    mockUseThreads.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useThreads>);
    mockUseSmartFolder.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSmartFolder>);

    renderPane();

    expect(screen.getByText(/Results for/)).toBeTruthy();
    const marks = screen.getAllByText("report");
    expect(marks.some((m) => m.tagName === "MARK")).toBe(true);
  });
});
