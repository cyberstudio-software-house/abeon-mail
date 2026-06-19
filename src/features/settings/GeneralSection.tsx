import { useGeneral } from "../../shared/general/GeneralProvider";
import { TIME_FORMATS } from "../../shared/general/general";
import { useAccounts } from "../../ipc/queries";
import { UpdatesPanel } from "../updates/UpdatesPanel";

export function GeneralSection() {
  const g = useGeneral();
  const { data: accounts = [] } = useAccounts();

  return (
    <div className="appearance-section">
      <p className="appearance-section__intro">General application preferences.</p>

      <div className="appearance-field__label">Default account</div>
      <select
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

      <div className="appearance-field__label">About</div>
      <UpdatesPanel />
    </div>
  );
}
