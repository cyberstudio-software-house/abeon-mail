export type TimeFormat = "system" | "12h" | "24h";

export type MarkReadMode = "immediate" | "delay" | "never";

export type ThreadOrder = "ascending" | "descending";

export type ListSortDir = "asc" | "desc";

export type GeneralFields = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
  markReadMode: MarkReadMode;
  markReadDelaySeconds: number;
  threadOrder: ThreadOrder;
  listSortDir: ListSortDir;
};

export const GENERAL_KEYS = {
  defaultAccountId: "general.defaultAccountId",
  timeFormat: "general.timeFormat",
  markReadMode: "general.markReadMode",
  markReadDelaySeconds: "general.markReadDelaySeconds",
  threadOrder: "general.threadOrder",
  listSortDir: "general.listSortDir",
} as const;

export const DEFAULT_GENERAL: GeneralFields = {
  defaultAccountId: "",
  timeFormat: "system",
  markReadMode: "immediate",
  markReadDelaySeconds: 2,
  threadOrder: "ascending",
  listSortDir: "desc",
};

export const TIME_FORMATS: { value: TimeFormat; label: string }[] = [
  { value: "system", label: "System" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];

export const MARK_READ_MODES: { value: MarkReadMode; label: string }[] = [
  { value: "immediate", label: "Immediately" },
  { value: "delay", label: "After a delay" },
  { value: "never", label: "Never" },
];

export const THREAD_ORDERS: { value: ThreadOrder; label: string }[] = [
  { value: "ascending", label: "Oldest first" },
  { value: "descending", label: "Newest first" },
];

function isTimeFormat(v: string): v is TimeFormat {
  return v === "system" || v === "12h" || v === "24h";
}

function isMarkReadMode(v: string): v is MarkReadMode {
  return v === "immediate" || v === "delay" || v === "never";
}

function isThreadOrder(v: string): v is ThreadOrder {
  return v === "ascending" || v === "descending";
}

function isListSortDir(v: string): v is ListSortDir {
  return v === "asc" || v === "desc";
}

export function parseGeneralSettings(pairs: [string, string][]): Partial<GeneralFields> {
  const out: Partial<GeneralFields> = {};
  for (const [key, value] of pairs) {
    switch (key) {
      case GENERAL_KEYS.defaultAccountId:
        out.defaultAccountId = value;
        break;
      case GENERAL_KEYS.timeFormat:
        if (isTimeFormat(value)) out.timeFormat = value;
        break;
      case GENERAL_KEYS.markReadMode:
        if (isMarkReadMode(value)) out.markReadMode = value;
        break;
      case GENERAL_KEYS.markReadDelaySeconds: {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 1 && n <= 60) out.markReadDelaySeconds = n;
        break;
      }
      case GENERAL_KEYS.threadOrder:
        if (isThreadOrder(value)) out.threadOrder = value;
        break;
      case GENERAL_KEYS.listSortDir:
        if (isListSortDir(value)) out.listSortDir = value;
        break;
      default:
        break;
    }
  }
  return out;
}
