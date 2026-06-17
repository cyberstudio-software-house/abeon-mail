import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SafeHtmlFrame } from "./SafeHtmlFrame";

describe("SafeHtmlFrame", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders an iframe with the provided html as srcDoc", () => {
    const html = "<p>hi</p>";
    render(<SafeHtmlFrame html={html} />);

    const iframe = document.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute("srcdoc")).toBe(html);
  });

  it("SECURITY: sandbox attribute is present and empty (no allow-scripts)", () => {
    render(<SafeHtmlFrame html="<p>test</p>" />);

    const iframe = document.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe!.hasAttribute("sandbox")).toBe(true);
    expect(iframe!.getAttribute("sandbox")).toBe("");
  });

  it("SECURITY: sandbox does not contain allow-scripts", () => {
    render(<SafeHtmlFrame html="<p>test</p>" />);

    const sandbox = document.querySelector("iframe")!.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
  });

  it("SECURITY: sandbox does not contain allow-same-origin", () => {
    render(<SafeHtmlFrame html="<p>test</p>" />);

    const sandbox = document.querySelector("iframe")!.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-same-origin");
  });
});
