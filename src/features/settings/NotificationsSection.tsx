import { useNotifications } from "../../shared/notifications/NotificationsProvider";

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

export function NotificationsSection() {
  const n = useNotifications();

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">
        Choose how AbeonMail alerts you to new mail on this device.
      </p>
      <Toggle
        label="Desktop notifications"
        hint="Show a system notification when new mail arrives while AbeonMail is in the background"
        checked={n.notificationsEnabled}
        onChange={n.setNotificationsEnabled}
      />
      <Toggle
        label="Unread badge"
        hint="Show the unread inbox count on the app icon"
        checked={n.badgeEnabled}
        onChange={n.setBadgeEnabled}
      />
      {n.notificationsEnabled && !n.permissionGranted && (
        <p className="appearance-section__intro" role="status">
          System notifications are blocked. Enable them in your operating system settings.
        </p>
      )}
    </div>
  );
}
