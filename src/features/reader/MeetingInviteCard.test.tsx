import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MeetingInviteCard } from "./MeetingInviteCard";

const mockRespond = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useMeetingInvite: () => ({ data: (globalThis as any).__invite, isLoading: false }),
  useRespondToInvite: () => ({ mutate: mockRespond }),
}));
vi.mock("../../ipc/bindings", () => ({ commands: { openExternalUrl: vi.fn() } }));
vi.mock("../../app/store", () => ({ useUiStore: (sel: any) => sel({ timeFormat: "24h" }) }));

function setInvite(overrides = {}) {
  (globalThis as any).__invite = {
    title: "Plant Tour 2.0", organizer: "org@x.com", organizer_name: null, location: "Microsoft Teams Meeting",
    start_epoch: 1761292800, end_epoch: 1761296400, all_day: false,
    join_url: "https://teams.microsoft.com/l/meetup-join/abc", provider: "teams", dial_in: "+48 22 536 42 02",
    method: "request", cancelled: false, uid: "U1", attendee_email: "me@x.com", response: null, can_rsvp: true,
    ...overrides,
  };
}

beforeEach(() => { mockRespond.mockReset(); setInvite(); });

describe("MeetingInviteCard", () => {
  it("renders title, provider and join button", () => {
    render(<MeetingInviteCard messageId={1} />);
    expect(screen.getByText("Plant Tour 2.0")).toBeTruthy();
    expect(screen.getByText("Microsoft Teams")).toBeTruthy();
    expect(screen.getByRole("button", { name: /join/i })).toBeTruthy();
  });

  it("RSVP click triggers the mutation with the chosen status", () => {
    render(<MeetingInviteCard messageId={1} />);
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    expect(mockRespond).toHaveBeenCalledWith({ messageId: 1, status: "accepted" });
  });

  it("cancelled invite hides join and RSVP and shows a badge", () => {
    setInvite({ cancelled: true });
    render(<MeetingInviteCard messageId={1} />);
    expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(screen.getByText(/cancelled/i)).toBeTruthy();
  });

  it("no join_url hides the join button", () => {
    setInvite({ join_url: null, provider: "other" });
    render(<MeetingInviteCard messageId={1} />);
    expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
  });

  it("renders nothing when there is no invite", () => {
    (globalThis as any).__invite = null;
    const { container } = render(<MeetingInviteCard messageId={1} />);
    expect(container.firstChild).toBeNull();
  });
});
