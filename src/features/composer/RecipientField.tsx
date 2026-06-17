import { useState, KeyboardEvent } from "react";

type Props = {
  label: string;
  recipients: string[];
  onChange: (recipients: string[]) => void;
};

export function RecipientField({ label, recipients, onChange }: Props) {
  const [inputValue, setInputValue] = useState("");

  function addRecipient(value: string) {
    const trimmed = value.trim();
    if (trimmed && !recipients.includes(trimmed)) {
      onChange([...recipients, trimmed]);
    }
    setInputValue("");
  }

  function removeRecipient(index: number) {
    onChange(recipients.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addRecipient(inputValue);
    } else if (e.key === "Backspace" && inputValue === "" && recipients.length > 0) {
      removeRecipient(recipients.length - 1);
    }
  }

  function handleBlur() {
    if (inputValue.trim()) {
      addRecipient(inputValue);
    }
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
        <input
          type="text"
          className="recipient-input"
          aria-label={label}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={recipients.length === 0 ? `Add ${label.toLowerCase()}...` : ""}
        />
      </div>
    </div>
  );
}
