export type TimeFormat = "system" | "12h" | "24h";

export type MarkReadMode = "immediate" | "delay" | "never";

export type GeneralFields = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
  markReadMode: MarkReadMode;
  markReadDelaySeconds: number;
};

export const GENERAL_KEYS = {
  defaultAccountId: "general.defaultAccountId",
  timeFormat: "general.timeFormat",
  markReadMode: "general.markReadMode",
  markReadDelaySeconds: "general.markReadDelaySeconds",
} as const;

export const DEFAULT_GENERAL: GeneralFields = {
  defaultAccountId: "",
  timeFormat: "system",
  markReadMode: "immediate",
  markReadDelaySeconds: 2,
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

function isTimeFormat(v: string): v is TimeFormat {
  return v === "system" || v === "12h" || v === "24h";
}

function isMarkReadMode(v: string): v is MarkReadMode {
  return v === "immediate" || v === "delay" || v === "never";
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
      default:
        break;
    }
  }
  return out;
}
