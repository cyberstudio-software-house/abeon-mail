import { describe, it, expect } from "vitest";
import {
  CONTENT_SECURITY_LEVELS,
  DEFAULT_CONTENT_SECURITY_LEVEL,
  sandboxForLevel,
  interceptLinksForLevel,
  autoloadRemoteForLevel,
  isExternalLink,
  parseContentSecurityLevel,
  type ContentSecurityLevel,
} from "./contentSecurity";

const LEVELS: ContentSecurityLevel[] = ["strict", "balanced", "open"];

describe("contentSecurity", () => {
  it("SECURITY: no level ever grants allow-scripts", () => {
    for (const level of LEVELS) {
      expect(sandboxForLevel(level)).not.toContain("allow-scripts");
    }
  });

  it("maps sandbox tokens per level", () => {
    expect(sandboxForLevel("strict")).toBe("");
    expect(sandboxForLevel("balanced")).toBe("allow-same-origin");
    expect(sandboxForLevel("open")).toBe("allow-same-origin");
  });

  it("intercepts links at non-strict levels only", () => {
    expect(interceptLinksForLevel("strict")).toBe(false);
    expect(interceptLinksForLevel("balanced")).toBe(true);
    expect(interceptLinksForLevel("open")).toBe(true);
  });

  it("auto-loads remote images only at the open level", () => {
    expect(autoloadRemoteForLevel("strict")).toBe(false);
    expect(autoloadRemoteForLevel("balanced")).toBe(false);
    expect(autoloadRemoteForLevel("open")).toBe(true);
  });

  it("recognizes http, https and tel links as external", () => {
    expect(isExternalLink("https://example.com")).toBe(true);
    expect(isExternalLink("HTTPS://EXAMPLE.COM")).toBe(true);
    expect(isExternalLink("http://insecure.test")).toBe(true);
    expect(isExternalLink("HTTP://INSECURE.TEST")).toBe(true);
    expect(isExternalLink("tel:+48123")).toBe(true);
    expect(isExternalLink("mailto:a@b.c")).toBe(false);
    expect(isExternalLink("javascript:alert(1)")).toBe(false);
    expect(isExternalLink("/relative")).toBe(false);
    expect(isExternalLink("")).toBe(false);
  });

  it("parses stored values and falls back to the default", () => {
    expect(parseContentSecurityLevel("strict")).toBe("strict");
    expect(parseContentSecurityLevel("open")).toBe("open");
    expect(parseContentSecurityLevel(undefined)).toBe(DEFAULT_CONTENT_SECURITY_LEVEL);
    expect(parseContentSecurityLevel("garbage")).toBe(DEFAULT_CONTENT_SECURITY_LEVEL);
  });

  it("exposes all three levels for the settings UI", () => {
    expect(CONTENT_SECURITY_LEVELS.map((l) => l.value)).toEqual(["strict", "balanced", "open"]);
    for (const l of CONTENT_SECURITY_LEVELS) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.description.length).toBeGreaterThan(0);
    }
  });
});
