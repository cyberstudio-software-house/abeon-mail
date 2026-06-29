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
    expect(DEFAULT_GENERAL).toEqual({
      defaultAccountId: "",
      timeFormat: "system",
      markReadMode: "immediate",
      markReadDelaySeconds: 2,
      threadOrder: "ascending",
      listSortDir: "desc",
    });
  });

  it("whitelists threadOrder and rejects junk", () => {
    expect(parseGeneralSettings([[GENERAL_KEYS.threadOrder, "ascending"]]).threadOrder).toBe("ascending");
    expect(parseGeneralSettings([[GENERAL_KEYS.threadOrder, "descending"]]).threadOrder).toBe("descending");
    expect(parseGeneralSettings([[GENERAL_KEYS.threadOrder, "nope"]]).threadOrder).toBeUndefined();
  });

  it("whitelists listSortDir and rejects junk", () => {
    expect(parseGeneralSettings([[GENERAL_KEYS.listSortDir, "asc"]]).listSortDir).toBe("asc");
    expect(parseGeneralSettings([[GENERAL_KEYS.listSortDir, "desc"]]).listSortDir).toBe("desc");
    expect(parseGeneralSettings([[GENERAL_KEYS.listSortDir, "nope"]]).listSortDir).toBeUndefined();
  });

  it("defaults listSortDir to desc", () => {
    expect(DEFAULT_GENERAL.listSortDir).toBe("desc");
  });

  it("whitelists markReadMode and rejects junk", () => {
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadMode, "immediate"]]).markReadMode).toBe("immediate");
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadMode, "delay"]]).markReadMode).toBe("delay");
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadMode, "never"]]).markReadMode).toBe("never");
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadMode, "nope"]]).markReadMode).toBeUndefined();
  });

  it("accepts an in-range integer markReadDelaySeconds and rejects junk", () => {
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "5"]]).markReadDelaySeconds).toBe(5);
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "0"]]).markReadDelaySeconds).toBeUndefined();
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "61"]]).markReadDelaySeconds).toBeUndefined();
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "2.5"]]).markReadDelaySeconds).toBeUndefined();
    expect(parseGeneralSettings([[GENERAL_KEYS.markReadDelaySeconds, "abc"]]).markReadDelaySeconds).toBeUndefined();
  });
});
