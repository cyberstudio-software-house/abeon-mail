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
