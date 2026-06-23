import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { SafeHtmlFrame } from "./SafeHtmlFrame";
import { commands } from "../../ipc/bindings";

vi.mock("../../ipc/bindings", () => ({
  commands: { openExternalUrl: vi.fn().mockResolvedValue({ status: "ok", data: null }) },
}));

async function getAnchor(): Promise<{ frame: HTMLIFrameElement; anchor: HTMLAnchorElement }> {
  const frame = document.querySelector("iframe") as HTMLIFrameElement;
  const anchor = await waitFor(() => {
    const a = frame.contentDocument?.querySelector("a");
    expect(a).toBeTruthy();
    return a as HTMLAnchorElement;
  });
  return { frame, anchor };
}

function clickInFrame(frame: HTMLIFrameElement, anchor: HTMLAnchorElement) {
  const MouseEventCtor = (frame.contentWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  anchor.dispatchEvent(new MouseEventCtor("click", { bubbles: true, cancelable: true }));
}

describe("SafeHtmlFrame", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders an iframe with the provided html as srcDoc", () => {
    const html = "<p>hi</p>";
    render(<SafeHtmlFrame html={html} />);
    const iframe = document.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute("srcdoc")).toBe(html);
  });

  it("SECURITY: default sandbox is present and empty", () => {
    render(<SafeHtmlFrame html="<p>test</p>" />);
    const iframe = document.querySelector("iframe");
    expect(iframe!.hasAttribute("sandbox")).toBe(true);
    expect(iframe!.getAttribute("sandbox")).toBe("");
  });

  it("SECURITY: never emits allow-scripts even when a sandbox is supplied", () => {
    render(<SafeHtmlFrame html="<p>test</p>" sandbox="allow-same-origin" />);
    const sandbox = document.querySelector("iframe")!.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
  });

  it("opens https links in the system browser when interceptLinks is on", async () => {
    render(
      <SafeHtmlFrame
        html={'<a href="https://example.com/x">link</a>'}
        sandbox="allow-same-origin"
        interceptLinks
      />
    );
    const { frame, anchor } = await getAnchor();
    clickInFrame(frame, anchor);
    expect(commands.openExternalUrl).toHaveBeenCalledWith("https://example.com/x");
  });

  it("opens http links in the system browser when interceptLinks is on", async () => {
    render(
      <SafeHtmlFrame
        html={'<a href="http://insecure.test/x">link</a>'}
        sandbox="allow-same-origin"
        interceptLinks
      />
    );
    const { frame, anchor } = await getAnchor();
    clickInFrame(frame, anchor);
    expect(commands.openExternalUrl).toHaveBeenCalledWith("http://insecure.test/x");
  });

  it("ignores unsupported schemes such as mailto", async () => {
    render(
      <SafeHtmlFrame
        html={'<a href="mailto:a@b.c">link</a>'}
        sandbox="allow-same-origin"
        interceptLinks
      />
    );
    const { frame, anchor } = await getAnchor();
    clickInFrame(frame, anchor);
    expect(commands.openExternalUrl).not.toHaveBeenCalled();
  });

  it("does not intercept clicks when interceptLinks is off", async () => {
    render(
      <SafeHtmlFrame html={'<a href="https://example.com/x">link</a>'} sandbox="allow-same-origin" />
    );
    const { frame, anchor } = await getAnchor();
    clickInFrame(frame, anchor);
    expect(commands.openExternalUrl).not.toHaveBeenCalled();
  });
});
