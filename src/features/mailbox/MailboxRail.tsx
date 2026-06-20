import { useState, useEffect, useRef } from "react";
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
  Plus,
} from "lucide-react";
import { useAccounts, useFolders, useLabels } from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { Avatar } from "../../shared/appearance/Avatar";
import {
  buildFolderTree,
  partitionPriorityFolders,
  sortFolderNodes,
  decodeImapUtf7,
} from "./folder-tree";
import type { FolderNode } from "./folder-tree";
import type { Account, SmartFolderKind } from "../../ipc/bindings";
import "./MailboxRail.css";

const SMART_FOLDERS: { label: string; kind: SmartFolderKind; Icon: React.ElementType }[] = [
  { label: "All Inboxes", kind: "all_inboxes", Icon: Layers },
  { label: "Unread", kind: "unread", Icon: MailOpen },
  { label: "Flagged", kind: "flagged", Icon: Flag },
  { label: "Snoozed", kind: "snoozed", Icon: Clock },
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
              className={`rail__item${isSelected ? " rail__item--active" : ""}`}
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

function AccountRow({
  account,
  isSelected,
  isExpanded,
  onClick,
}: {
  account: Account;
  isSelected: boolean;
  isExpanded: boolean;
  onClick: (id: number) => void;
}) {
  return (
    <div
      className={`rail__account-row${isSelected ? " rail__account-row--active" : ""}`}
      onClick={() => onClick(account.id)}
    >
      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <Avatar seed={account.email} label={account.display_name || account.email} size={22} />
      <span className="rail__item-label">{account.display_name || account.email}</span>
      {account.requires_reauth && (
        <span
          className="rail__reauth-badge"
          title="Reconnect needed — open Settings → Accounts"
          aria-label={`Account ${account.display_name || account.email} needs reconnect`}
        >
          ⚠
        </span>
      )}
    </div>
  );
}

export function MailboxRail() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<number>>(new Set());

  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const selectedLabelId = useUiStore((s) => s.selectedLabelId);
  const setSelectedAccountId = useUiStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);
  const setSelectedSmartFolder = useUiStore((s) => s.setSelectedSmartFolder);
  const setSelectedLabelId = useUiStore((s) => s.setSelectedLabelId);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
  const openSettings = useUiStore((s) => s.openSettings);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const setSearchQuery = useUiStore((s) => s.setSearchQuery);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const setFocusSearch = useUiStore((s) => s.setFocusSearch);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { data: labels = [] } = useLabels();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: folders = [] } = useFolders(selectedAccountId);

  const { priority: priorityFolders, rest: restFolders } = partitionPriorityFolders(folders);
  const priorityNodes: FolderNode[] = priorityFolders.map((f) => ({
    segment: decodeImapUtf7(f.name),
    fullPath: f.remote_path,
    folder: f,
    children: [],
  }));
  const restTree = sortFolderNodes(buildFolderTree(restFolders));

  const folderIds = folders.map((f) => f.id).join(",");
  useEffect(() => {
    const tree = buildFolderTree(partitionPriorityFolders(folders).rest);
    setExpanded(new Set(tree.map((n) => n.fullPath)));
  }, [folderIds]);

  useEffect(() => {
    setFocusSearch(() => searchInputRef.current?.focus());
    return () => setFocusSearch(null);
  }, [setFocusSearch]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleAccountClick(accountId: number) {
    if (selectedAccountId === accountId) {
      setCollapsedAccounts((prev) => {
        const next = new Set(prev);
        if (next.has(accountId)) next.delete(accountId);
        else next.add(accountId);
        return next;
      });
      return;
    }
    setSelectedAccountId(accountId);
    setSelectedFolderId(null);
    setCollapsedAccounts((prev) => {
      if (!prev.has(accountId)) return prev;
      const next = new Set(prev);
      next.delete(accountId);
      return next;
    });
  }

  function handleFolderClick(folderId: number, accountId: number) {
    setSelectedAccountId(accountId);
    setSelectedFolderId(folderId);
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

      <div className="rail__search">
        <Search size={15} />
        <input
          ref={searchInputRef}
          className="rail__search-input"
          type="text"
          value={searchQuery}
          placeholder="Search all mail"
          aria-label="Search mail"
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              clearSearch();
              searchInputRef.current?.blur();
            }
          }}
        />
        {searchQuery.length > 0 && (
          <button
            type="button"
            className="rail__search-clear"
            aria-label="Clear search"
            onClick={() => clearSearch()}
          >
            ✕
          </button>
        )}
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
        {!accountsLoading && accounts.length > 0 && (
          <>
            <div className="rail__section">Accounts</div>
            {accounts.map((account) => {
              const isExpanded =
                selectedAccountId === account.id && !collapsedAccounts.has(account.id);
              return (
              <div key={account.id}>
                <AccountRow
                  account={account}
                  isSelected={selectedAccountId === account.id}
                  isExpanded={isExpanded}
                  onClick={handleAccountClick}
                />
                {isExpanded && (
                  <>
                    <FolderTreeNodes
                      nodes={priorityNodes}
                      depth={0}
                      expanded={expanded}
                      toggle={toggle}
                      selectedFolderId={selectedFolderId}
                      onFolderClick={handleFolderClick}
                    />
                    <FolderTreeNodes
                      nodes={restTree}
                      depth={0}
                      expanded={expanded}
                      toggle={toggle}
                      selectedFolderId={selectedFolderId}
                      onFolderClick={handleFolderClick}
                    />
                  </>
                )}
              </div>
              );
            })}
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
        {labels.map((label) => (
          <div
            key={label.id}
            className={`rail__item${selectedLabelId === label.id ? " rail__item--active" : ""}`}
            onClick={() => setSelectedLabelId(label.id)}
          >
            <span
              className="rail__label-dot"
              style={{ background: label.color }}
              aria-hidden="true"
            />
            <span className="rail__item-label">{label.name}</span>
          </div>
        ))}
        <div
          className="rail__item rail__new-label"
          onClick={() => openLabelPicker([])}
          role="button"
        >
          <Plus size={15} className="rail__item-icon" />
          <span className="rail__item-label">New label</span>
        </div>
      </nav>

      <footer className="rail__footer">
        <button
          type="button"
          className="rail__settings"
          onClick={openSettings}
          aria-label="Open settings"
        >
          <Settings size={16} />
        </button>
      </footer>
    </aside>
  );
}
