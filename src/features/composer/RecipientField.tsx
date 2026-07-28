import { useState, KeyboardEvent } from "react";
import { useContactSuggestions } from "../../ipc/queries";

type Props = {
  label: string;
  recipients: string[];
  onChange: (recipients: string[]) => void;
  accountId: number | null;
};

const MAX_SUGGESTIONS = 8;

export function RecipientField({ label, recipients, onChange, accountId }: Props) {
  const [inputValue, setInputValue] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  const { data: suggestions } = useContactSuggestions(dismissed ? "" : inputValue, accountId);
  const chosen = new Set(recipients.map((r) => r.trim().toLowerCase()));
  const visible = (suggestions ?? [])
    .filter((s) => !chosen.has(s.email))
    .slice(0, MAX_SUGGESTIONS);
  const isOpen = !dismissed && visible.length > 0;

  function addRecipient(value: string) {
    const trimmed = value.trim();
    if (trimmed && !recipients.includes(trimmed)) {
      onChange([...recipients, trimmed]);
    }
    setInputValue("");
    setActiveIndex(-1);
    setDismissed(false);
  }

  function removeRecipient(index: number) {
    onChange(recipients.filter((_, i) => i !== index));
  }

  function handleChange(value: string) {
    setInputValue(value);
    setActiveIndex(-1);
    setDismissed(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (isOpen && e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % visible.length);
      return;
    }
    if (isOpen && e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? visible.length - 1 : i - 1));
      return;
    }
    if (isOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      setActiveIndex(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "," || (e.key === "Tab" && activeIndex >= 0)) {
      if (isOpen && activeIndex >= 0) {
        e.preventDefault();
        addRecipient(visible[activeIndex].email);
        return;
      }
      if (e.key === "Tab") {
        return;
      }
      e.preventDefault();
      addRecipient(inputValue);
      return;
    }
    if (e.key === "Backspace" && inputValue === "" && recipients.length > 0) {
      removeRecipient(recipients.length - 1);
    }
  }

  function handleBlur() {
    if (inputValue.trim()) {
      addRecipient(inputValue);
    }
    setDismissed(true);
  }

  return (
    <div className="recipient-field">
      <span className="recipient-label">{label}</span>
      <div className="recipient-chips">
        {recipients.map((r, i) => (
          <span key={r} className="recipient-chip">
            {r}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${r}`}
              onClick={() => removeRecipient(i)}
            >
              ×
            </button>
          </span>
        ))}
        <div className="recipient-input-wrap">
          <input
            type="text"
            className="recipient-input"
            aria-label={label}
            role="combobox"
            aria-expanded={isOpen}
            aria-autocomplete="list"
            value={inputValue}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={recipients.length === 0 ? `Add ${label.toLowerCase()}...` : ""}
          />
          {isOpen && (
            <ul className="recipient-suggestions" role="listbox">
              {visible.map((s, i) => (
                <li
                  key={s.email}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={i === activeIndex ? "suggestion active" : "suggestion"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addRecipient(s.email);
                  }}
                >
                  {s.name && <span className="suggestion-name">{s.name}</span>}
                  <span className="suggestion-email">{s.email}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
