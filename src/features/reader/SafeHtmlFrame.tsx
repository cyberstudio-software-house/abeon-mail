import { useEffect, useRef } from "react";
import { commands } from "../../ipc/bindings";
import { isExternalLink } from "../../shared/contentSecurity";

export function SafeHtmlFrame({
  html,
  title = "message-content",
  className = "reader-frame",
  sandbox = "",
  interceptLinks = false,
}: {
  html: string;
  title?: string;
  className?: string;
  sandbox?: string;
  interceptLinks?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);

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
