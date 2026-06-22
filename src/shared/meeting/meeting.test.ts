import { describe, it, expect } from "vitest";
import { formatMeetingRange, meetingBadgeLabel, providerLabel } from "./meeting";

describe("formatMeetingRange", () => {
  it("formats a same-day range with start and end time", () => {
    const out = formatMeetingRange(1761292800, 1761296400, false, "24h");
    expect(out).toMatch(/2025/);
    expect(out).toContain("–");
  });

  it("formats all-day without a time", () => {
    const out = formatMeetingRange(1761264000, null, true, "system");
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("collapses a one-day all-day span to a single date", () => {
    const start = Date.UTC(2026, 7, 3) / 1000;
    const exclusiveEnd = Date.UTC(2026, 7, 4) / 1000;
    expect(formatMeetingRange(start, exclusiveEnd, true, "system")).toBe(
      formatMeetingRange(start, null, true, "system"),
    );
  });

  it("renders a multi-day all-day event as a range", () => {
    const start = Date.UTC(2026, 7, 3) / 1000;
    const exclusiveEnd = Date.UTC(2026, 7, 15) / 1000;
    const out = formatMeetingRange(start, exclusiveEnd, true, "system");
    expect(out).toContain("–");
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
    expect(out).not.toBe(formatMeetingRange(start, null, true, "system"));
  });
});

describe("meetingBadgeLabel", () => {
  it("labels an event without an online meeting as a calendar event", () => {
    expect(meetingBadgeLabel({ provider: "other", join_url: null, dial_in: null })).toBe("Event");
  });

  it("labels an unknown provider with a join link as an online meeting", () => {
    expect(
      meetingBadgeLabel({ provider: "other", join_url: "https://x.example/j", dial_in: null }),
    ).toBe("Online meeting");
  });

  it("treats a dial-in as an online meeting", () => {
    expect(meetingBadgeLabel({ provider: "other", join_url: null, dial_in: "+48 22 000" })).toBe(
      "Online meeting",
    );
  });

  it("uses the provider name when a meeting provider is recognized", () => {
    expect(meetingBadgeLabel({ provider: "teams", join_url: null, dial_in: null })).toBe(
      "Microsoft Teams",
    );
  });
});

describe("providerLabel", () => {
  it("maps provider enum to a human label", () => {
    expect(providerLabel("teams")).toBe("Microsoft Teams");
    expect(providerLabel("google_meet")).toBe("Google Meet");
    expect(providerLabel("zoom")).toBe("Zoom");
    expect(providerLabel("webex")).toBe("Webex");
    expect(providerLabel("other")).toBe("Online meeting");
  });
});
