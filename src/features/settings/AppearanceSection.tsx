import { useAppearance } from "../../shared/appearance/AppearanceProvider";
import { THEME_MODES, ACCENT_PRESETS, DENSITIES } from "../../shared/appearance/appearance";

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="appearance-toggle">
      <div className="appearance-toggle__text">
        <div className="appearance-toggle__label">{label}</div>
        {hint && <div className="appearance-toggle__hint">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch${checked ? " switch--on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}

export function AppearanceSection() {
  const a = useAppearance();

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">
        Personalize how AbeonMail looks on this device.
      </p>

      <div className="appearance-field__label">Theme</div>
      <div className="theme-cards">
        {THEME_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={a.theme === m.value}
            className={`theme-card${a.theme === m.value ? " theme-card--active" : ""}`}
            onClick={() => a.setTheme(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="appearance-field__label">Accent color</div>
      <div className="accent-swatches">
        {ACCENT_PRESETS.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={`Accent ${hex}`}
            aria-pressed={a.accent === hex}
            className={`accent-swatch${a.accent === hex ? " accent-swatch--active" : ""}`}
            style={{ background: hex }}
            onClick={() => a.setAccent(hex)}
          >
            {a.accent === hex && <span className="accent-swatch__check" aria-hidden="true">✓</span>}
          </button>
        ))}
      </div>

      <div className="appearance-field__label">Message density</div>
      <div className="density-cards">
        {DENSITIES.map((d) => (
          <button
            key={d.value}
            type="button"
            aria-pressed={a.density === d.value}
            className={`density-card${a.density === d.value ? " density-card--active" : ""}`}
            onClick={() => a.setDensity(d.value)}
          >
            <span className="density-card__label">{d.label}</span>
            <span className="density-card__hint">{d.hint}</span>
          </button>
        ))}
      </div>

      <div className="appearance-field__label">Message list</div>
      <Toggle
        label="Show preview text"
        hint="Display the first line of each message"
        checked={a.showPreview}
        onChange={a.setShowPreview}
      />
      <Toggle
        label="Show sender avatars"
        checked={a.showAvatars}
        onChange={a.setShowAvatars}
      />
    </div>
  );
}
