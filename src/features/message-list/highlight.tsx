import type { ReactNode } from "react";

export function extractTerms(query: string): string[] {
  const terms: string[] = [];
  for (const token of query.split(/\s+/)) {
    if (token.length === 0) continue;
    const colon = token.indexOf(":");
    if (colon !== -1) {
      const key = token.slice(0, colon).toLowerCase();
      if (key === "from" || key === "to" || key === "subject" || key === "has") {
        continue;
      }
    }
    terms.push(token);
  }
  return terms;
}

function buildFoldedIndex(text: string): { foldedText: string; originStart: number[]; originEnd: number[] } {
  const foldedText: string[] = [];
  const originStart: number[] = [];
  const originEnd: number[] = [];

  const codePoints = [...text];
  let charOffset = 0;
  for (const ch of codePoints) {
    const charEnd = charOffset + ch.length;
    const folded = ch.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    for (let i = 0; i < folded.length; i++) {
      foldedText.push(folded[i]);
      originStart.push(charOffset);
      originEnd.push(charEnd);
    }
    charOffset = charEnd;
  }

  return { foldedText: foldedText.join(""), originStart, originEnd };
}

export function Highlight({ text, terms }: { text: string; terms: string[] }): ReactNode {
  const cleaned = terms
    .map((t) => t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase())
    .filter((t) => t.length > 0);
  if (cleaned.length === 0) return text;

  const { foldedText, originStart, originEnd } = buildFoldedIndex(text);

  const ranges: Array<[number, number]> = [];
  for (const term of cleaned) {
    let from = 0;
    while (true) {
      const idx = foldedText.indexOf(term, from);
      if (idx === -1) break;
      const foldedEnd = idx + term.length;
      const origStart = originStart[idx];
      const origEnd = foldedEnd < originEnd.length ? originEnd[foldedEnd - 1] : text.length;
      ranges.push([origStart, origEnd]);
      from = foldedEnd;
    }
  }
  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={i}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
