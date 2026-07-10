import { describe, it, expect, vi } from "vitest";
import {
  rewriteInlineSrcs,
  saveInlineImageAttachment,
  reconstructDraftInlineImages,
  generateContentId,
} from "./inlineImages";

describe("generateContentId", () => {
  it("returns distinct, well-formed ids on consecutive calls", () => {
    const first = generateContentId();
    const second = generateContentId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^inline-.+@abeonmail$/);
    expect(second).toMatch(/^inline-.+@abeonmail$/);
  });
});

describe("rewriteInlineSrcs", () => {
  it("rewrites a mapped data URI to a cid", () => {
    const map = new Map([["data:image/png;base64,AAA", "inline-1@abeonmail"]]);
    const html = '<p><img src="data:image/png;base64,AAA"></p>';
    expect(rewriteInlineSrcs(html, map)).toBe('<p><img src="cid:inline-1@abeonmail"></p>');
  });

  it("leaves unmapped srcs unchanged", () => {
    const html = '<img src="https://example.com/a.png">';
    expect(rewriteInlineSrcs(html, new Map())).toBe(html);
  });
});

describe("saveInlineImageAttachment", () => {
  it("saves the blob and returns an attachment carrying the generated content id", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const saveInlineImage = vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        filename: "pasted-image.png",
        mime_type: "image/png",
        blob_ref: "/data/inline_images/pasted-image.png",
        content_id: null,
      },
    });
    const res = await saveInlineImageAttachment(blob, saveInlineImage);
    expect(saveInlineImage).toHaveBeenCalledWith("image/png", expect.any(String));
    expect(res.attachment.content_id).toBe(res.contentId);
    expect(res.dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("throws when the backend rejects the image", async () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const saveInlineImage = vi
      .fn()
      .mockResolvedValue({ status: "error", error: "Image is too large (max 25 MB)" });
    await expect(saveInlineImageAttachment(blob, saveInlineImage)).rejects.toThrow("too large");
  });
});

describe("reconstructDraftInlineImages", () => {
  it("replaces cid refs with data URIs and returns map entries", async () => {
    const html = '<p><img src="cid:inline-1@abeonmail"></p>';
    const attachments = [
      {
        filename: "a.png",
        mime_type: "image/png",
        blob_ref: "/data/inline_images/a.png",
        content_id: "inline-1@abeonmail",
      },
    ];
    const readInlineImage = vi.fn().mockResolvedValue({ status: "ok", data: "QUFB" });
    const { html: out, entries } = await reconstructDraftInlineImages(
      html,
      attachments,
      readInlineImage,
    );
    expect(out).toBe('<p><img src="data:image/png;base64,QUFB"></p>');
    expect(entries).toEqual([["data:image/png;base64,QUFB", "inline-1@abeonmail"]]);
  });

  it("skips attachments the backend cannot read", async () => {
    const html = '<img src="cid:inline-9@abeonmail">';
    const attachments = [
      {
        filename: "x.png",
        mime_type: "image/png",
        blob_ref: "/outside/x.png",
        content_id: "inline-9@abeonmail",
      },
    ];
    const readInlineImage = vi.fn().mockResolvedValue({ status: "error", error: "not found" });
    const { html: out, entries } = await reconstructDraftInlineImages(
      html,
      attachments,
      readInlineImage,
    );
    expect(out).toBe(html);
    expect(entries).toEqual([]);
  });
});
