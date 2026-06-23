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
