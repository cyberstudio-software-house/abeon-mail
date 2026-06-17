import type { Endpoints } from "../../ipc/bindings";

interface Props {
  endpoints: Endpoints;
  onChange: (endpoints: Endpoints) => void;
}

export function EndpointsForm({ endpoints, onChange }: Props) {
  const set = (key: keyof Endpoints, value: string | number | boolean) =>
    onChange({ ...endpoints, [key]: value });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <fieldset
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm)",
          padding: "var(--space-3)",
        }}
      >
        <legend style={{ color: "var(--text-secondary)", fontSize: "12px", padding: "0 4px" }}>
          IMAP
        </legend>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Host</span>
            <input
              value={endpoints.imap_host}
              onChange={(e) => set("imap_host", e.target.value)}
              style={inputStyle}
            />
          </label>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", flex: 1 }}>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Port</span>
              <input
                type="number"
                value={endpoints.imap_port}
                onChange={(e) => set("imap_port", Number(e.target.value))}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", marginTop: "auto" }}>
              <input
                type="checkbox"
                checked={endpoints.imap_tls}
                onChange={(e) => set("imap_tls", e.target.checked)}
              />
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>TLS</span>
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm)",
          padding: "var(--space-3)",
        }}
      >
        <legend style={{ color: "var(--text-secondary)", fontSize: "12px", padding: "0 4px" }}>
          SMTP
        </legend>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Host</span>
            <input
              value={endpoints.smtp_host}
              onChange={(e) => set("smtp_host", e.target.value)}
              style={inputStyle}
            />
          </label>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", flex: 1 }}>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Port</span>
              <input
                type="number"
                value={endpoints.smtp_port}
                onChange={(e) => set("smtp_port", Number(e.target.value))}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", marginTop: "auto" }}>
              <input
                type="checkbox"
                checked={endpoints.smtp_tls}
                onChange={(e) => set("smtp_tls", e.target.checked)}
              />
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>TLS</span>
            </label>
          </div>
        </div>
      </fieldset>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-app)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  fontSize: "14px",
  padding: "var(--space-2) var(--space-3)",
  width: "100%",
  boxSizing: "border-box",
};
