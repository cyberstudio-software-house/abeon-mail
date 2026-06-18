import { useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useAccounts,
  useFolders,
  useRemoveAccount,
  useBeginReauth,
  useReorderAccounts,
} from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { AddAccountWizard } from "../accounts/AddAccountWizard";
import type { Account, SmartFolderKind } from "../../ipc/bindings";

const SMART_FOLDERS: { label: string; kind: SmartFolderKind }[] = [
  { label: "All Inboxes", kind: "all_inboxes" },
  { label: "Unread", kind: "unread" },
  { label: "Flagged", kind: "flagged" },
];

interface RemoveConfirmProps {
  account: Account;
  onConfirm: () => void;
  onCancel: () => void;
}

function RemoveConfirmDialog({ account, onConfirm, onCancel }: RemoveConfirmProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        style={{
          background: "var(--bg-surface)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-6)",
          maxWidth: 380,
          width: "100%",
        }}
      >
        <p style={{ marginBottom: "var(--space-4)", fontSize: "14px" }}>
          Permanently remove <strong>{account.display_name || account.email}</strong>? This deletes all
          locally cached messages and cannot be undone.
        </p>
        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            aria-label="Cancel"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-1) var(--space-3)",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            aria-label="Confirm"
            style={{
              background: "var(--color-red-600, #dc2626)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              color: "white",
              padding: "var(--space-1) var(--space-3)",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

interface SortableAccountRowProps {
  account: Account;
  isSelected: boolean;
  onAccountClick: (id: number) => void;
  onRemoveClick: (account: Account) => void;
  onReauthClick: (id: number) => void;
  children?: React.ReactNode;
}

function SortableAccountRow({
  account,
  isSelected,
  onAccountClick,
  onRemoveClick,
  onReauthClick,
  children,
}: SortableAccountRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: account.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-4)",
          cursor: "pointer",
          fontSize: "14px",
          borderRadius: "var(--radius-sm)",
          margin: "1px var(--space-2)",
          fontWeight: isSelected ? 600 : 400,
          color: isSelected ? "var(--accent)" : "var(--text-on-rail)",
        }}
      >
        <span
          {...attributes}
          {...listeners}
          style={{ cursor: "grab", padding: "0 2px", color: "var(--text-muted)" }}
          aria-label={`Drag to reorder ${account.display_name || account.email}`}
        >
          ⠿
        </span>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: account.color ?? "var(--accent)",
            flexShrink: 0,
          }}
          onClick={() => onAccountClick(account.id)}
        />
        <span style={{ flex: 1 }} onClick={() => onAccountClick(account.id)}>
          {account.display_name || account.email}
        </span>
        {account.requires_reauth && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReauthClick(account.id);
            }}
            aria-label={`Reconnect account ${account.display_name || account.email}`}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: "12px",
              color: "var(--color-amber-500, #f59e0b)",
              padding: "0 2px",
            }}
          >
            ⚠ Reconnect
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemoveClick(account);
          }}
          aria-label={`Remove account ${account.display_name || account.email}`}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: "12px",
            color: "var(--text-muted)",
            padding: "0 2px",
            opacity: 0.5,
          }}
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

interface Props {
  status?: string;
}

export function MailboxRail({ status }: Props) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmAccount, setConfirmAccount] = useState<Account | null>(null);

  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const setSelectedAccountId = useUiStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);
  const setSelectedSmartFolder = useUiStore((s) => s.setSelectedSmartFolder);
  const openSettings = useUiStore((s) => s.openSettings);

  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: folders = [] } = useFolders(selectedAccountId);
  const removeAccount = useRemoveAccount();
  const beginReauth = useBeginReauth();
  const reorderAccounts = useReorderAccounts();

  const sensors = useSensors(useSensor(PointerSensor));

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

  function handleRemoveClick(account: Account) {
    setConfirmAccount(account);
  }

  function handleRemoveConfirm() {
    if (confirmAccount) {
      removeAccount.mutate(confirmAccount.id);
    }
    setConfirmAccount(null);
  }

  function handleRemoveCancel() {
    setConfirmAccount(null);
  }

  function handleReauthClick(accountId: number) {
    beginReauth.mutate(accountId);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = accounts.findIndex((a) => a.id === active.id);
    const newIndex = accounts.findIndex((a) => a.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(accounts, oldIndex, newIndex);
    reorderAccounts.mutate(reordered.map((a) => a.id));
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
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={accounts.map((a) => a.id)}
                strategy={verticalListSortingStrategy}
              >
                {accounts.map((account) => (
                  <SortableAccountRow
                    key={account.id}
                    account={account}
                    isSelected={selectedAccountId === account.id}
                    onAccountClick={handleAccountClick}
                    onRemoveClick={handleRemoveClick}
                    onReauthClick={handleReauthClick}
                  >
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
                  </SortableAccountRow>
                ))}
              </SortableContext>
            </DndContext>
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

      <div style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-3)" }}>
        <button
          onClick={() => setWizardOpen(true)}
          style={{
            flex: 1,
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
        <button
          type="button"
          onClick={openSettings}
          aria-label="Open settings"
          style={{
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-on-rail)",
            cursor: "pointer",
            fontSize: "14px",
            padding: "var(--space-2) var(--space-3)",
          }}
        >
          ⚙
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

      {confirmAccount && (
        <RemoveConfirmDialog
          account={confirmAccount}
          onConfirm={handleRemoveConfirm}
          onCancel={handleRemoveCancel}
        />
      )}
    </aside>
  );
}
