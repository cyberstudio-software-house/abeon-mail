export function SafeHtmlFrame({ html }: { html: string }) {
  return (
    <iframe
      title="message-content"
      sandbox=""
      srcDoc={html}
      className="reader-frame"
    />
  );
}
