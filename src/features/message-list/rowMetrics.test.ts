import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HEADER_HEIGHT } from "./rowMetrics";

const css = readFileSync(resolve(process.cwd(), "src/features/message-list/MessageListPane.css"), "utf-8");
const groupRule = css.match(/\.message-list__group\s*\{([^}]*)\}/)?.[1] ?? "";

function pixels(property: string): number[] {
  const value = groupRule.match(new RegExp(`(?:^|;|\\{)\\s*${property}\\s*:([^;]*)`, "m"))?.[1];
  return [...(value ?? "").matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
}

describe("group header metrics", () => {
  it("declares the same height in CSS as HEADER_HEIGHT", () => {
    expect(pixels("height")).toEqual([HEADER_HEIGHT]);
  });

  it("keeps padding and line box within the declared height", () => {
    const [top, , bottom] = pixels("padding");
    const [lineHeight] = pixels("line-height");
    expect(lineHeight).toBeGreaterThan(0);
    expect(top + lineHeight + bottom).toBeLessThanOrEqual(HEADER_HEIGHT);
  });
});
