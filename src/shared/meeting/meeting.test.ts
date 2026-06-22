import { describe, it, expect } from "vitest";
import { formatMeetingRange, providerLabel } from "./meeting";

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
