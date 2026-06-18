import { useState, useEffect } from "react";
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
  Search,
  Layers,
  MailOpen,
  Flag,
  Clock,
  Settings,
  ChevronRight,
  ChevronDown,
  Inbox,
  Send,
  FileText,
  Archive,
  ShieldAlert,
  Trash2,
  Folder,
} from "lucide-react";
import {
  useAccounts,
  useFolders,
  useRemoveAccount,
  useBeginReauth,
  useReorderAccounts,
} from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { AddAccountWizard } from "../accounts/AddAccountWizard";
import { Avatar } from "../../shared/appearance/Avatar";
import { buildFolderTree } from "./folder-tree";
import type { FolderNode } from "./folder-tree";
import type { Account, SmartFolderKind } from "../../ipc/bindings";
import "./MailboxRail.css";

const SMART_FOLDERS: { label: string; kind: SmartFolderKind; Icon: React.ElementType }[] = [
  { label: "All Inboxes", kind: "all_inboxes", Icon: Layers },
  { label: "Unread", kind: "unread", Icon: MailOpen },
  { label: "Flagged", kind: "flagged", Icon: Flag },
];

function FolderIcon({ folderType }: { folderType?: string }) {
  const Icon =
    folderType === "inbox" ? Inbox :
    folderType === "sent" ? Send :
    folderType === "drafts" ? FileText :
    folderType === "archive" ? Archive :
    folderType === "spam" ? ShieldAlert :
    folderType === "trash" ? Trash2 :
    Folder;
  return <Icon size={15} className="rail__item-icon" />;
}

function FolderTreeNodes({
  nodes,
  depth,
  expanded,
  toggle,
  selectedFolderId,
  onFolderClick,
}: {
  nodes: FolderNode[];
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  selectedFolderId: number | null;
  onFolderClick: (folderId: number, accountId: number) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isOpen = expanded.has(node.fullPath);
        const isSelected = node.folder != null && selectedFolderId === node.folder.id;
        return (
          <div key={node.fullPath}>
            <div
              className={`rail__item rail__folder${isSelected ? " rail__item--active" : ""}`}
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              aria-disabled={node.folder == null ? true : undefined}
              onClick={() => {
                if (hasChildren) toggle(node.fullPath);
                if (node.folder) onFolderClick(node.folder.id, node.folder.account_id);
              }}
            >
              {hasChildren ? (
                isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
              ) : (
                <span className="rail__chevron-spacer" />
              )}
              <FolderIcon folderType={node.folder?.folder_type} />
              <span className="rail__item-label">{node.segment}</span>
              {node.folder != null && node.folder.unread_count > 0 && (
                <span className="rail__count">{node.folder.unread_count}</span>
              )}
            </div>
            {hasChildren && isOpen && (
              <FolderTreeNodes
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                selectedFolderId={selectedFolderId}
                onFolderClick={onFolderClick}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

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
}

function SortableAccountRow({
  account,
  isSelected,
  onAccountClick,
  onRemoveClick,
  onReauthClick,
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
        className={`rail__account-row${isSelected ? " rail__account-row--active" : ""}`}
        onClick={() => onAccountClick(account.id)}
      >
        <span
          {...attributes}
          {...listeners}
          style={{ cursor: "grab", padding: "0 2px", color: "var(--text-muted)" }}
          aria-label={`Drag to reorder ${account.display_name || account.email}`}
        >
          ⠿
        </span>
        <Avatar
          seed={account.email}
          label={account.display_name || account.email}
          size={22}
        />
        <span className="rail__item-label">{account.display_name || account.email}</span>
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
    </div>
  );
}

interface Props {
  status?: string;
}

export function MailboxRail({ status }: Props) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmAccount, setConfirmAccount] = useState<Account | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    const tree = buildFolderTree(folders);
    setExpanded(new Set(tree.map((n) => n.fullPath)));
  }, [folders]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

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

  const headerAccount = accounts.find((a) => a.id === selectedAccountId) ?? accounts[0];

  return (
    <aside className="rail">
      <header className="rail__header">
        <div className="rail__logo">A</div>
        <span className="rail__title">AbeonMail</span>
        {headerAccount && (
          <Avatar
            seed={headerAccount.email}
            label={headerAccount.display_name || headerAccount.email}
            size={30}
          />
        )}
      </header>

      <div className="rail__search" aria-disabled="true">
        <Search size={15} />
        <span>Search</span>
      </div>

      <nav className="rail__scroll">
        <div className="rail__section">Smart Folders</div>
        {SMART_FOLDERS.map(({ label, kind, Icon }) => (
          <div
            key={kind}
            className={`rail__item${selectedSmartFolder === kind ? " rail__item--active" : ""}`}
            onClick={() => setSelectedSmartFolder(kind)}
          >
            <Icon size={15} className="rail__item-icon" />
            <span className="rail__item-label">{label}</span>
          </div>
        ))}
        <div className="rail__item" aria-disabled="true">
          <Clock size={15} className="rail__item-icon" />
          <span className="rail__item-label">Snoozed</span>
        </div>

        {!accountsLoading && accounts.length > 0 && (
          <>
            <div className="rail__section">Accounts</div>
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
                  <div key={account.id}>
                    <SortableAccountRow
                      account={account}
                      isSelected={selectedAccountId === account.id}
                      onAccountClick={handleAccountClick}
                      onRemoveClick={handleRemoveClick}
                      onReauthClick={handleReauthClick}
                    />
                    {selectedAccountId === account.id && (
                      <FolderTreeNodes
                        nodes={buildFolderTree(folders)}
                        depth={0}
                        expanded={expanded}
                        toggle={toggle}
                        selectedFolderId={selectedFolderId}
                        onFolderClick={handleFolderClick}
                      />
                    )}
                  </div>
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

        <div className="rail__section">Labels</div>
        <div className="rail__placeholder" aria-disabled="true">Coming soon</div>
      </nav>

      <footer className="rail__footer">
        <button
          className="rail__add"
          onClick={() => setWizardOpen(true)}
        >
          Add account
        </button>
        <button
          type="button"
          className="rail__settings"
          onClick={openSettings}
          aria-label="Open settings"
        >
          <Settings size={16} />
        </button>
      </footer>

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
