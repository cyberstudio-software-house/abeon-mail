export function SafeHtmlFrame({
  html,
  title = "message-content",
  className = "reader-frame",
}: {
  html: string;
  title?: string;
  className?: string;
}) {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html}
      className={className}
    />
  );
}
