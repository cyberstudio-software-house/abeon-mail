import type { TimeFormat } from "../general/general";

export function hour12Option(fmt: TimeFormat): boolean | undefined {
  if (fmt === "12h") return true;
  if (fmt === "24h") return false;
  return undefined;
}

export function formatMessageTime(epochSeconds: number, fmt: TimeFormat): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12Option(fmt),
  });
}

export function formatListDate(epochSeconds: number, fmt: TimeFormat): string {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: hour12Option(fmt),
    });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatWakeTime(epochSeconds: number, fmt: TimeFormat): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12Option(fmt),
  });
}
