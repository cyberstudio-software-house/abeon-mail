export type QuoteSplit = { collapsed: string; full: string; hasHistory: boolean };

const ATTRIBUTION_PATTERNS: RegExp[] = [
  /^on\b.{0,240}\bwrote:\s*$/i,
  /^w dniu\b.{0,240}\b(?:pisze|napisał(?:a|\(a\))?)\s*:\s*$/i,
  /^dnia\b.{0,240}\bnapisał(?:a|\(a\))?\s*:\s*$/i,
  /^wiadomość napisana przez\b.{0,240}:\s*$/i,
  /^am\b.{0,240}\bschrieb:\s*$/i,
  /^-{2,}\s*(?:original message|wiadomość oryginalna|ursprüngliche nachricht)\s*-{2,}\s*$/i,
];

const HEADER_BLOCK = /^(?:from|od|von):\s.*\b(?:sent|wysłano|gesendet):/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isAttributionText(value: string): boolean {
  const text = normalizeWhitespace(value);
  if (text.length === 0) return false;
  if (HEADER_BLOCK.test(text)) return true;
  if (text.length > 280) return false;
  return ATTRIBUTION_PATTERNS.some((re) => re.test(text));
}

function isHeaderBlockStart(lines: string[], index: number): boolean {
  if (!/^\s*(?:from|od|von):\s*\S/i.test(lines[index])) return false;
  const window = lines.slice(index + 1, index + 6).join("\n");
  return /^\s*(?:sent|wysłano|gesendet|to|do|an):/im.test(window);
}

export function splitTextHistory(text: string): QuoteSplit {
  const full = text;
  const lines = text.split("\n");
  let boundary = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i]) || isAttributionText(lines[i]) || isHeaderBlockStart(lines, i)) {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) return { collapsed: full, full, hasHistory: false };
  const collapsed = lines.slice(0, boundary).join("\n").replace(/\s+$/, "");
  if (collapsed.trim().length === 0) return { collapsed: full, full, hasHistory: false };
  return { collapsed, full, hasHistory: true };
}

const QUOTE_SELECTORS = [
  ".gmail_quote",
  ".gmail_quote_container",
  "#appendonsend",
  "#divRplyFwdMsg",
  'blockquote[type="cite"]',
  ".moz-cite-prefix",
  ".yahoo_quoted",
  "#yahoo_quoted",
  ".protonmail_quote",
].join(",");

function findHtmlBoundary(body: HTMLElement): Element | null {
  const selectorMatch = body.querySelector(QUOTE_SELECTORS);
  let attributionMatch: Element | null = null;
  for (const element of Array.from(body.querySelectorAll("*"))) {
    if (isAttributionText(element.textContent ?? "")) {
      attributionMatch = element;
      break;
    }
  }
  if (selectorMatch && attributionMatch) {
    const position = selectorMatch.compareDocumentPosition(attributionMatch);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? attributionMatch : selectorMatch;
  }
  return selectorMatch ?? attributionMatch;
}

function cutFromBoundary(boundary: Element, body: HTMLElement): void {
  let node: Node | null = boundary;
  while (node && node !== body) {
    let sibling = node.nextSibling;
    while (sibling) {
      const next = sibling.nextSibling;
      sibling.parentNode?.removeChild(sibling);
      sibling = next;
    }
    node = node.parentNode;
  }
  boundary.parentNode?.removeChild(boundary);
}

function isMeaningfullyEmpty(body: HTMLElement): boolean {
  const hasText = (body.textContent ?? "").replace(/\s+/g, "").length > 0;
  const hasMedia = body.querySelector("img,table,hr,video,iframe") !== null;
  return !hasText && !hasMedia;
}

export function splitHtmlHistory(html: string): QuoteSplit {
  const full = html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.body;
    const boundary = findHtmlBoundary(body);
    if (!boundary) return { collapsed: full, full, hasHistory: false };
    cutFromBoundary(boundary, body);
    if (isMeaningfullyEmpty(body)) return { collapsed: full, full, hasHistory: false };
    return { collapsed: body.innerHTML, full, hasHistory: true };
  } catch {
    return { collapsed: full, full, hasHistory: false };
  }
}
