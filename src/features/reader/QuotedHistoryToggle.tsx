export function QuotedHistoryToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = expanded ? "Ukryj cytowaną historię" : "Pokaż cytowaną historię";
  return (
    <button
      type="button"
      className="quoted-history-toggle"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {expanded ? label : "•••"}
    </button>
  );
}
