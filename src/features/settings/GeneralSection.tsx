import { useGeneral } from "../../shared/general/GeneralProvider";
import { TIME_FORMATS, MARK_READ_MODES, THREAD_ORDERS } from "../../shared/general/general";
import { useAccounts, useContentSecurityLevel, useSetContentSecurityLevel } from "../../ipc/queries";
import {
  CONTENT_SECURITY_LEVELS,
  DEFAULT_CONTENT_SECURITY_LEVEL,
  type ContentSecurityLevel,
} from "../../shared/contentSecurity";
import { UpdatesPanel } from "../updates/UpdatesPanel";

export function GeneralSection() {
  const g = useGeneral();
  const { data: accounts = [] } = useAccounts();
  const { data: contentSecurity = DEFAULT_CONTENT_SECURITY_LEVEL } = useContentSecurityLevel();
  const setContentSecurity = useSetContentSecurityLevel();
  const activeContentSecurity = CONTENT_SECURITY_LEVELS.find((l) => l.value === contentSecurity);

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">General application preferences.</p>

      <div className="settings-field">
        <div className="settings-field__label">Default account</div>
        <select
          className="settings-select"
          aria-label="Default account"
          value={g.defaultAccountId}
          onChange={(e) => g.setDefaultAccountId(e.target.value)}
        >
          <option value="">Automatic (first account)</option>
          {accounts.map((a) => (
            <option key={a.id} value={String(a.id)}>
              {a.email}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <div className="settings-field__label">Email content security</div>
        <select
          className="settings-select"
          aria-label="Email content security"
          value={contentSecurity}
          onChange={(e) => setContentSecurity.mutate(e.target.value as ContentSecurityLevel)}
        >
          {CONTENT_SECURITY_LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        {activeContentSecurity && (
          <div className="settings-field__hint">{activeContentSecurity.description}</div>
        )}
      </div>

      <div className="appearance-field__label">Time format</div>
      <div className="theme-cards">
        {TIME_FORMATS.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={g.timeFormat === t.value}
            className={`theme-card${g.timeFormat === t.value ? " theme-card--active" : ""}`}
            onClick={() => g.setTimeFormat(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="appearance-field__label">Mark messages as read</div>
      <div className="theme-cards">
        {MARK_READ_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={g.markReadMode === m.value}
            className={`theme-card${g.markReadMode === m.value ? " theme-card--active" : ""}`}
            onClick={() => g.setMarkReadMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="appearance-field__label">Conversation order</div>
      <div className="theme-cards">
        {THREAD_ORDERS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={g.threadOrder === o.value}
            className={`theme-card${g.threadOrder === o.value ? " theme-card--active" : ""}`}
            onClick={() => g.setThreadOrder(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {g.markReadMode === "delay" && (
        <>
          <div className="appearance-field__label">Delay (seconds)</div>
          <input
            type="number"
            aria-label="Mark as read delay seconds"
            min={1}
            max={60}
            value={g.markReadDelaySeconds}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 60) g.setMarkReadDelaySeconds(n);
            }}
          />
        </>
      )}

      <div className="settings-field">
        <div className="settings-field__label">About</div>
        <UpdatesPanel />
      </div>
    </div>
  );
}
