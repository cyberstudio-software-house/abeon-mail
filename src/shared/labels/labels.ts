export const LABEL_COLORS: string[] = [
  "#4f46e5",
  "#7c3aed",
  "#0ea5e9",
  "#10b981",
  "#ef5d3a",
  "#ec4899",
  "#f59e0b",
  "#0d9488",
];

export function nextLabelColor(used: string[]): string {
  const free = LABEL_COLORS.find((c) => !used.includes(c));
  return free ?? LABEL_COLORS[used.length % LABEL_COLORS.length];
}

export function labelTextColor(hex: string): string {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length !== 6) return "#ffffff";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return "#ffffff";
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 110 ? "#000000" : "#ffffff";
}
