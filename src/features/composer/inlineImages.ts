import type { OutgoingAttachment } from "../../ipc/bindings";

type CommandResult<T> = { status: "ok"; data: T } | { status: "error"; error: string };

let inlineImageCounter = 0;

export function generateContentId(): string {
  inlineImageCounter += 1;
  return `inline-${inlineImageCounter}@abeonmail`;
}

export function rewriteInlineSrcs(html: string, srcToContentId: Map<string, string>): string {
  return html.replace(/<img([^>]*)\ssrc="([^"]*)"([^>]*)>/g, (match, before, src, after) => {
    const contentId = srcToContentId.get(src);
    if (contentId) {
      return `<img${before} src="cid:${contentId}"${after}>`;
    }
    return match;
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}

export interface InlineImageInsert {
  dataUri: string;
  contentId: string;
  attachment: OutgoingAttachment;
}

export async function saveInlineImageAttachment(
  blob: Blob,
  saveInlineImage: (
    mimeType: string,
    dataBase64: string,
  ) => Promise<CommandResult<OutgoingAttachment>>,
): Promise<InlineImageInsert> {
  const dataUri = await blobToDataUrl(blob);
  const base64 = dataUri.split(",")[1] ?? "";
  const mimeType = blob.type || "image/png";
  const result = await saveInlineImage(mimeType, base64);
  if (result.status !== "ok") {
    throw new Error(result.error);
  }
  const contentId = generateContentId();
  return { dataUri, contentId, attachment: { ...result.data, content_id: contentId } };
}

export async function reconstructDraftInlineImages(
  html: string,
  attachments: OutgoingAttachment[],
  readInlineImage: (blobRef: string) => Promise<CommandResult<string>>,
): Promise<{ html: string; entries: Array<[string, string]> }> {
  let out = html;
  const entries: Array<[string, string]> = [];
  for (const att of attachments) {
    if (!att.content_id || !att.blob_ref) continue;
    const result = await readInlineImage(att.blob_ref);
    if (result.status !== "ok") continue;
    const dataUri = `data:${att.mime_type};base64,${result.data}`;
    out = out.split(`cid:${att.content_id}`).join(dataUri);
    entries.push([dataUri, att.content_id]);
  }
  return { html: out, entries };
}
