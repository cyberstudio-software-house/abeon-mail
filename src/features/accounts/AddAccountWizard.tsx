import { useState } from "react";
import type { Endpoints } from "../../ipc/bindings";
import { useResolveEndpoints, useAddAccount } from "../../ipc/queries";
import { EndpointsForm } from "./EndpointsForm";

interface Props {
  onClose: () => void;
  onAdded: (accountId: number) => void;
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

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const labelTextStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
};

export function AddAccountWizard({ onClose, onAdded }: Props) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [endpoints, setEndpoints] = useState<Endpoints | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const resolveEndpoints = useResolveEndpoints();
  const addAccount = useAddAccount();

  async function handleContinue() {
    try {
      const result = await resolveEndpoints.mutateAsync(email);
      setEndpoints(result);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddAccount() {
    if (!endpoints) return;
    setAddError(null);
    setIsAdding(true);
    try {
      const account = await addAccount.mutateAsync({ email, displayName, password, endpoints });
      onAdded(account.id);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsAdding(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-subtle)",
        padding: "var(--space-6)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
        width: "400px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "16px", color: "var(--text-primary)" }}>
          {endpoints ? "Server settings" : "Add account"}
        </h2>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            fontSize: "18px",
            padding: "0",
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {!endpoints ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <label style={labelStyle}>
            <span style={labelTextStyle}>Email</span>
            <input
              id="wizard-email"
              aria-label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
              autoComplete="email"
            />
          </label>
          <label style={labelStyle}>
            <span style={labelTextStyle}>Display name</span>
            <input
              id="wizard-display-name"
              aria-label="Display name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={inputStyle}
              autoComplete="name"
            />
          </label>
          <label style={labelStyle}>
            <span style={labelTextStyle}>Password</span>
            <input
              id="wizard-password"
              aria-label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
              autoComplete="current-password"
            />
          </label>
          <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "14px",
                padding: "var(--space-2) var(--space-4)",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleContinue}
              disabled={!email || !password || resolveEndpoints.isPending}
              style={{
                background: "var(--accent)",
                border: "none",
                borderRadius: "var(--radius-sm)",
                color: "#fff",
                cursor: "pointer",
                fontSize: "14px",
                padding: "var(--space-2) var(--space-4)",
                opacity: !email || !password ? 0.6 : 1,
              }}
            >
              {resolveEndpoints.isPending ? "Resolving…" : "Continue"}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <EndpointsForm endpoints={endpoints} onChange={setEndpoints} />
          {addError && (
            <p style={{ color: "var(--color-error)", fontSize: "13px", margin: 0 }}>{addError}</p>
          )}
          <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
            <button
              onClick={() => setEndpoints(null)}
              style={{
                background: "none",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "14px",
                padding: "var(--space-2) var(--space-4)",
              }}
            >
              Back
            </button>
            <button
              onClick={handleAddAccount}
              disabled={isAdding}
              style={{
                background: "var(--accent)",
                border: "none",
                borderRadius: "var(--radius-sm)",
                color: "#fff",
                cursor: isAdding ? "not-allowed" : "pointer",
                fontSize: "14px",
                padding: "var(--space-2) var(--space-4)",
                opacity: isAdding ? 0.7 : 1,
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              {isAdding && (
                <span
                  style={{
                    display: "inline-block",
                    width: "12px",
                    height: "12px",
                    border: "2px solid rgba(255,255,255,0.4)",
                    borderTopColor: "#fff",
                    borderRadius: "50%",
                    animation: "spin 0.7s linear infinite",
                  }}
                />
              )}
              {isAdding ? "Adding…" : "Add account"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
