import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const mockOpenComposer = vi.fn();

vi.mock("../../ipc/queries", () => ({
  useDraftSummaries: vi.fn(),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { getDraft: vi.fn() },
}));

vi.mock("../../app/store", () => ({
  useUiStore: vi.fn(),
}));

import { useDraftSummaries } from "../../ipc/queries";
import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { DraftsList } from "./DraftsList";
import type { DraftSummary, OutgoingMessage } from "../../ipc/bindings";

const mockUseDraftSummaries = vi.mocked(useDraftSummaries);
const mockUseUiStore = vi.mocked(useUiStore);
const mockGetDraft = vi.mocked(commands.getDraft);

function setupStore() {
  mockUseUiStore.mockImplementation((selector: (s: any) => unknown) =>
    selector({
      openComposer: mockOpenComposer,
      timeFormat: "24h",
      density: "comfortable",
      showAvatars: false,
      showPreview: true,
    })
  );
}

const drafts: DraftSummary[] = [
  { id: 11637, account_id: 1, to: ["alice@example.com"], subject: "Test po aktualizacji", date: 1700000000, snippet: "", has_attachments: false },
  { id: 4085, account_id: 1, to: [], subject: "", date: 1699990000, snippet: "", has_attachments: false },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DraftsList", () => {
  it("renders a row per draft with subject and recipient", () => {
    setupStore();
    mockUseDraftSummaries.mockReturnValue({ data: drafts, isLoading: false } as unknown as ReturnType<typeof useDraftSummaries>);

    render(<DraftsList accountId={1} />);

    expect(screen.getByText("Test po aktualizacji")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText("(No subject)")).toBeTruthy();
  });

  it("opens the composer with the loaded draft when a row is clicked", async () => {
    setupStore();
    mockUseDraftSummaries.mockReturnValue({ data: drafts, isLoading: false } as unknown as ReturnType<typeof useDraftSummaries>);
    const loaded: OutgoingMessage = {
      from_address: "me@example.com",
      from_name: "Me",
      to: ["alice@example.com"],
      cc: [],
      bcc: [],
      subject: "Test po aktualizacji",
      text_body: "body",
      html_body: "<p>body</p>",
      in_reply_to: null,
      references: [],
      attachments: [],
    };
    mockGetDraft.mockResolvedValue({ status: "ok", data: loaded });

    render(<DraftsList accountId={1} />);
    fireEvent.click(screen.getByText("Test po aktualizacji"));

    await waitFor(() => {
      expect(mockGetDraft).toHaveBeenCalledWith(11637);
      expect(mockOpenComposer).toHaveBeenCalledWith(11637, loaded);
    });
  });

  it("shows an empty state when there are no drafts", () => {
    setupStore();
    mockUseDraftSummaries.mockReturnValue({ data: [], isLoading: false } as unknown as ReturnType<typeof useDraftSummaries>);

    render(<DraftsList accountId={1} />);

    expect(screen.getByText("No drafts")).toBeTruthy();
  });
});
