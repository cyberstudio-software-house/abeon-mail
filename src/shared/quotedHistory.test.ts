import { describe, it, expect } from "vitest";
import { splitTextHistory, isAttributionText } from "./quotedHistory";

describe("isAttributionText", () => {
  it("matches English 'On … wrote:'", () => {
    expect(isAttributionText("On Mon, Jun 23, 2026 at 10:00 AM John <j@x.com> wrote:")).toBe(true);
  });
  it("matches Polish 'W dniu … pisze:'", () => {
    expect(isAttributionText("W dniu 23.06.2026 o 10:00, Jan Kowalski pisze:")).toBe(true);
  });
  it("matches an Outlook header block on one line", () => {
    expect(isAttributionText("From: a@x.com Sent: Monday To: b@y.com Subject: Hi")).toBe(true);
  });
  it("rejects ordinary prose ending in a colon", () => {
    expect(isAttributionText("On Monday we shipped the feature:")).toBe(false);
  });
});

describe("splitTextHistory", () => {
  it("collapses from the first '>'-quoted block", () => {
    const text = "Thanks, that works.\n\n> previous line one\n> previous line two";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toBe("Thanks, that works.");
    expect(r.full).toBe(text);
  });

  it("collapses from a Polish attribution line", () => {
    const text = "Dziękuję.\n\nW dniu 23.06.2026 o 10:00, Jan pisze:\nstara treść";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toBe("Dziękuję.");
  });

  it("collapses from a multi-line From/Sent/To header block", () => {
    const text = "Reply body\n\nFrom: a@x.com\nSent: Monday\nTo: b@y.com\nSubject: Hi\nold body";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toBe("Reply body");
  });

  it("returns no history when there is no quote", () => {
    const text = "Just a plain note with no history.";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(false);
    expect(r.collapsed).toBe(text);
    expect(r.full).toBe(text);
  });

  it("does not collapse when the whole body is a quote (empty reply guard)", () => {
    const text = "> only quoted content\n> second line";
    const r = splitTextHistory(text);
    expect(r.hasHistory).toBe(false);
    expect(r.collapsed).toBe(text);
  });
});
