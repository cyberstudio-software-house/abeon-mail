import { useState } from "react";
import { useAccounts, useFolders } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { AddAccountWizard } from "../accounts/AddAccountWizard";
import type { SmartFolderKind } from "../../ipc/bindings";

const SMART_FOLDERS: { label: string; kind: SmartFolderKind }[] = [
  { label: "All Inboxes", kind: "all_inboxes" },
  { label: "Unread", kind: "unread" },
  { label: "Flagged", kind: "flagged" },
];

interface Props {
  status?: string;
}

export function MailboxRail({ status }: Props) {
  const [wizardOpen, setWizardOpen] = useState(false);

  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const setSelectedAccountId = useUiStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);
  const setSelectedSmartFolder = useUiStore((s) => s.setSelectedSmartFolder);

  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: folders = [] } = useFolders(selectedAccountId);

  function handleAccountClick(accountId: number) {
    setSelectedAccountId(accountId);
    setSelectedFolderId(null);
  }

  function handleFolderClick(folderId: number, accountId: number) {
    setSelectedAccountId(accountId);
    setSelectedFolderId(folderId);
  }

  function handleAdded(accountId: number) {
    setSelectedAccountId(accountId);
    setWizardOpen(false);
  }

  return (
    <aside
      className="rail"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-rail)",
        color: "var(--text-on-rail)",
      }}
    >
      <div style={{ padding: "var(--space-4)", fontWeight: 700, fontSize: "15px" }}>
        AbeonMail
      </div>

      <nav style={{ flex: 1, overflowY: "auto" }}>
        <div
          style={{
            padding: "var(--space-2) var(--space-3)",
            fontSize: "11px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            marginTop: "var(--space-2)",
          }}
        >
          Smart Folders
        </div>
        {SMART_FOLDERS.map(({ label, kind }) => (
          <div
            key={kind}
            onClick={() => setSelectedSmartFolder(kind)}
            style={{
              padding: "var(--space-2) var(--space-4)",
              fontSize: "14px",
              borderRadius: "var(--radius-sm)",
              margin: "1px var(--space-2)",
              cursor: "pointer",
              fontWeight: selectedSmartFolder === kind ? 600 : 400,
              color: selectedSmartFolder === kind ? "var(--accent)" : "var(--text-on-rail)",
            }}
          >
            {label}
          </div>
        ))}

        {!accountsLoading && accounts.length > 0 && (
          <>
            <div
              style={{
                padding: "var(--space-2) var(--space-3)",
                fontSize: "11px",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-muted)",
                marginTop: "var(--space-3)",
              }}
            >
              Accounts
            </div>
            {accounts.map((account) => (
              <div key={account.id}>
                <div
                  onClick={() => handleAccountClick(account.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    padding: "var(--space-2) var(--space-4)",
                    cursor: "pointer",
                    fontSize: "14px",
                    borderRadius: "var(--radius-sm)",
                    margin: "1px var(--space-2)",
                    fontWeight: selectedAccountId === account.id ? 600 : 400,
                    color:
                      selectedAccountId === account.id
                        ? "var(--accent)"
                        : "var(--text-on-rail)",
                  }}
                >
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: account.color ?? "var(--accent)",
                      flexShrink: 0,
                    }}
                  />
                  {account.display_name || account.email}
                </div>

                {selectedAccountId === account.id &&
                  folders.map((folder) => (
                    <div
                      key={folder.id}
                      onClick={() => handleFolderClick(folder.id, account.id)}
                      style={{
                        padding: "var(--space-1) var(--space-4)",
                        paddingLeft: "calc(var(--space-4) + 20px)",
                        cursor: "pointer",
                        fontSize: "13px",
                        borderRadius: "var(--radius-sm)",
                        margin: "1px var(--space-2)",
                        color:
                          selectedFolderId === folder.id
                            ? "var(--accent)"
                            : "var(--text-on-rail)",
                        fontWeight: selectedFolderId === folder.id ? 600 : 400,
                      }}
                    >
                      {folder.name}
                      {folder.unread_count > 0 && (
                        <span
                          style={{ marginLeft: "var(--space-2)", fontSize: "11px", opacity: 0.7 }}
                        >
                          {folder.unread_count}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </>
        )}

        {!accountsLoading && accounts.length === 0 && (
          <div
            style={{
              padding: "var(--space-4)",
              fontSize: "13px",
              color: "var(--text-muted)",
              textAlign: "center",
            }}
          >
            No accounts yet
          </div>
        )}
      </nav>

      <div style={{ padding: "var(--space-3)" }}>
        <button
          onClick={() => setWizardOpen(true)}
          style={{
            width: "100%",
            background: "var(--accent)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-white)",
            cursor: "pointer",
            fontSize: "13px",
            padding: "var(--space-2) var(--space-3)",
          }}
        >
          Add account
        </button>
      </div>

      {status !== undefined && (
        <div
          className="status"
          style={{
            padding: "var(--space-2) var(--space-4)",
            fontSize: "11px",
            color: "var(--text-muted)",
          }}
        >
          IPC: {status}
        </div>
      )}

      {wizardOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <AddAccountWizard onClose={() => setWizardOpen(false)} onAdded={handleAdded} />
        </div>
      )}
    </aside>
  );
}
