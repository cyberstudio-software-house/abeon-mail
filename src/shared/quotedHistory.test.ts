import { describe, it, expect } from "vitest";
import { splitTextHistory, isAttributionText, splitHtmlHistory } from "./quotedHistory";

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

describe("splitHtmlHistory", () => {
  it("collapses a Gmail gmail_quote container", () => {
    const html =
      "<div>My reply.</div>" +
      '<div class="gmail_quote"><div class="gmail_attr">On Mon wrote:</div>' +
      "<blockquote>old</blockquote></div>";
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("My reply.");
    expect(r.collapsed).not.toContain("gmail_quote");
    expect(r.collapsed).not.toContain("old");
    expect(r.full).toBe(html);
  });

  it("collapses an Outlook reply divider", () => {
    const html =
      "<div>Reply here</div>" +
      '<div id="divRplyFwdMsg"><b>From:</b> a@x.com</div><div>quoted body</div>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("Reply here");
    expect(r.collapsed).not.toContain("quoted body");
  });

  it("collapses an Apple Mail blockquote[type=cite]", () => {
    const html = '<div>Sure.</div><blockquote type="cite">old thread</blockquote>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("Sure.");
    expect(r.collapsed).not.toContain("old thread");
  });

  it("collapses via attribution fallback when no known class is present", () => {
    const html =
      "<p>New message</p><p>W dniu 23.06.2026 o 10:00, Jan pisze:</p>" +
      "<p>poprzednia treść</p>";
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("New message");
    expect(r.collapsed).not.toContain("poprzednia treść");
  });

  it("returns no history when there is no quote", () => {
    const html = "<p>Standalone message, nothing quoted.</p>";
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(false);
    expect(r.collapsed).toBe(html);
  });

  it("keeps an image-only reply (does not treat it as empty)", () => {
    const html =
      '<div><img src="cid:logo"></div>' +
      '<blockquote type="cite">old thread</blockquote>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(true);
    expect(r.collapsed).toContain("<img");
  });

  it("does not collapse when the whole body is a quote (empty reply guard)", () => {
    const html = '<blockquote type="cite">entire body is quoted</blockquote>';
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(false);
    expect(r.collapsed).toBe(html);
  });

  it("falls back to full content on unparseable input without throwing", () => {
    const html = "<<< not really html >>>";
    const r = splitHtmlHistory(html);
    expect(r.hasHistory).toBe(false);
    expect(r.full).toBe(html);
  });
});
