export type TimeFormat = "system" | "12h" | "24h";

export type GeneralFields = {
  defaultAccountId: string;
  timeFormat: TimeFormat;
};

export const GENERAL_KEYS = {
  defaultAccountId: "general.defaultAccountId",
  timeFormat: "general.timeFormat",
} as const;

export const DEFAULT_GENERAL: GeneralFields = {
  defaultAccountId: "",
  timeFormat: "system",
};

export const TIME_FORMATS: { value: TimeFormat; label: string }[] = [
  { value: "system", label: "System" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];

function isTimeFormat(v: string): v is TimeFormat {
  return v === "system" || v === "12h" || v === "24h";
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
      default:
        break;
    }
  }
  return out;
}
