import { useEffect, useRef } from "react";
import { commands } from "../../ipc/bindings";
import { isExternalLink } from "../../shared/contentSecurity";

const SANDBOXED_FRAME_HEIGHT = 600;

export function SafeHtmlFrame({
  html,
  title = "message-content",
  className = "reader-frame",
  sandbox = "",
  interceptLinks = false,
  autoResize = false,
}: {
  html: string;
  title?: string;
  className?: string;
  sandbox?: string;
  interceptLinks?: boolean;
  autoResize?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!autoResize) return;
    const frame = frameRef.current;
    if (!frame) return;

    let observer: ResizeObserver | null = null;

    const resize = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      const height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
      if (height > 0) frame.style.height = `${height}px`;
    };

    const attach = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) {
        frame.style.height = `${SANDBOXED_FRAME_HEIGHT}px`;
        return;
      }
      resize();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(resize);
        observer.observe(doc.documentElement);
      }
    };

    frame.addEventListener("load", attach);
    attach();

    return () => {
      frame.removeEventListener("load", attach);
      observer?.disconnect();
    };
  }, [html, autoResize]);

  useEffect(() => {
    if (!interceptLinks) return;
    const frame = frameRef.current;
    if (!frame) return;

    const handleClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!isExternalLink(href)) return;
      event.preventDefault();
      void commands.openExternalUrl(href);
    };

    const attach = () => {
      frame.contentDocument?.addEventListener("click", handleClick);
    };

    frame.addEventListener("load", attach);
    attach();

    return () => {
      frame.removeEventListener("load", attach);
      frame.contentDocument?.removeEventListener("click", handleClick);
    };
  }, [html, interceptLinks]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={sandbox}
      srcDoc={html}
      className={className}
    />
  );
}
