import { describe, it, expect } from "vitest";
import { parseGeneralSettings, DEFAULT_GENERAL, GENERAL_KEYS } from "./general";

describe("parseGeneralSettings", () => {
  it("reads defaultAccountId as a raw string", () => {
    const out = parseGeneralSettings([[GENERAL_KEYS.defaultAccountId, "7"]]);
    expect(out.defaultAccountId).toBe("7");
  });

  it("accepts an empty defaultAccountId (automatic)", () => {
    const out = parseGeneralSettings([[GENERAL_KEYS.defaultAccountId, ""]]);
    expect(out.defaultAccountId).toBe("");
  });

  it("whitelists timeFormat and rejects junk", () => {
    expect(parseGeneralSettings([[GENERAL_KEYS.timeFormat, "12h"]]).timeFormat).toBe("12h");
    expect(parseGeneralSettings([[GENERAL_KEYS.timeFormat, "24h"]]).timeFormat).toBe("24h");
    expect(parseGeneralSettings([[GENERAL_KEYS.timeFormat, "system"]]).timeFormat).toBe("system");
    expect(parseGeneralSettings([[GENERAL_KEYS.timeFormat, "nonsense"]]).timeFormat).toBeUndefined();
  });

  it("ignores unrelated keys", () => {
    expect(parseGeneralSettings([["appearance.theme", "dark"]])).toEqual({});
  });

  it("exposes defaults", () => {
    expect(DEFAULT_GENERAL).toEqual({ defaultAccountId: "", timeFormat: "system" });
  });
});
