export type ContentSecurityLevel = "strict" | "balanced" | "open";

export const DEFAULT_CONTENT_SECURITY_LEVEL: ContentSecurityLevel = "balanced";

export const CONTENT_SECURITY_LEVELS: {
  value: ContentSecurityLevel;
  label: string;
  description: string;
}[] = [
  {
    value: "strict",
    label: "Strict",
    description:
      "Maximum isolation. External links are disabled and remote images stay blocked unless enabled per account.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description:
      "Links open in your system browser and scripts never run. Remote images follow each account's setting.",
  },
  {
    value: "open",
    label: "Open",
    description:
      "Links open in your system browser and remote images load for every account. Scripts never run.",
  },
];

export function sandboxForLevel(level: ContentSecurityLevel): string {
  return level === "strict" ? "" : "allow-same-origin";
}

export function interceptLinksForLevel(level: ContentSecurityLevel): boolean {
  return level !== "strict";
}

export function autoloadRemoteForLevel(level: ContentSecurityLevel): boolean {
  return level === "open";
}

export function isExternalLink(href: string): boolean {
  const lower = href.trim().toLowerCase();
  return lower.startsWith("https://") || lower.startsWith("tel:");
}

export function parseContentSecurityLevel(value: string | undefined): ContentSecurityLevel {
  return value === "strict" || value === "balanced" || value === "open"
    ? value
    : DEFAULT_CONTENT_SECURITY_LEVEL;
}
