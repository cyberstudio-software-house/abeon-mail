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
  Folder as FolderIconLucide,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  useAccounts,
  useFolders,
  useLabels,
  useAllAccountFolders,
  usePinnedMap,
  useTogglePinnedFolder,
  usePrefetchFoldersMap,
  useToggleFolderPrefetch,
  useMarkFolderRead,
  useRenameFolder,
  useDeleteFolder,
  useCreateSubfolder,
  useSyncNow,
} from "../../ipc/queries";
import { useUiStore } from "../../app/store";
import { Avatar } from "../../shared/appearance/Avatar";
import { Wordmark } from "../../shared/brand/Wordmark";
import {
  buildFolderTree,
  partitionPriorityFolders,
  sortFolderNodes,
} from "./folder-tree";
import type { FolderNode } from "./folder-tree";
import { selectInboxes, selectPinnedByAccount, isFolderPinned } from "./pinned";
import { isFolderPrefetched } from "./prefetch";
import { RailContextMenu } from "./RailContextMenu";
import { TextInputDialog, ConfirmDialog } from "./RailDialogs";
import { ErrorToast } from "./ErrorToast";
import type { ContextMenuItem } from "./RailContextMenu";
import type { Account, Folder, SmartFolderKind } from "../../ipc/bindings";
import { SMART_FOLDER_META } from "../../shared/smartFolders";
import "./MailboxRail.css";

const SMART_FOLDER_ICONS: Record<SmartFolderKind, React.ElementType> = {
  all_inboxes: Layers,
  unread: MailOpen,
  flagged: Flag,
  snoozed: Clock,
};

function folderBadgeCount(folder: Folder): number {
  return folder.folder_type === "drafts" ? folder.total_count : folder.unread_count;
}

function FolderIcon({ folderType }: { folderType?: string }) {
  const Icon =
    folderType === "inbox" ? Inbox :
    folderType === "sent" ? Send :
    folderType === "drafts" ? FileText :
    folderType === "archive" ? Archive :
    folderType === "spam" ? ShieldAlert :
    folderType === "trash" ? Trash2 :
    FolderIconLucide;
  return <Icon size={15} className="rail__item-icon" />;
}

function FolderTreeNodes({
  nodes,
  depth,
  expanded,
  toggle,
  selectedFolderId,
  onFolderClick,
  onFolderContextMenu,
}: {
  nodes: FolderNode[];
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  selectedFolderId: number | null;
  onFolderClick: (folderId: number, accountId: number) => void;
  onFolderContextMenu: (event: React.MouseEvent, folder: Folder) => void;
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
              onContextMenu={
                node.folder ? (event) => onFolderContextMenu(event, node.folder!) : undefined
              }
            >
              {hasChildren ? (
                isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
              ) : (
                <span className="rail__chevron-spacer" />
              )}
              <FolderIcon folderType={node.folder?.folder_type} />
              <span className="rail__item-label">{node.segment}</span>
              {node.folder != null && folderBadgeCount(node.folder) > 0 && (
                <span className="rail__count">{folderBadgeCount(node.folder)}</span>
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
                onFolderContextMenu={onFolderContextMenu}
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
      <Avatar
        seed={account.email}
        label={account.display_name || account.email}
        size={22}
        variant="account"
      />
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
  const smartFoldersEnabled = useUiStore((s) => s.smartFoldersEnabled);
  const smartFolderVisibility = useUiStore((s) => s.smartFolderVisibility);
  const setSelectedAccountId = useUiStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);
  const setSelectedSmartFolder = useUiStore((s) => s.setSelectedSmartFolder);
  const setSelectedLabelId = useUiStore((s) => s.setSelectedLabelId);
  const openLabelPicker = useUiStore((s) => s.openLabelPicker);
  const openSettings = useUiStore((s) => s.openSettings);
  const prefetchProgress = useUiStore((s) => s.prefetchProgress);
  const showErrorToast = useUiStore((s) => s.showErrorToast);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const setSearchQuery = useUiStore((s) => s.setSearchQuery);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const setFocusSearch = useUiStore((s) => s.setFocusSearch);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { data: labels = [] } = useLabels();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const { data: folders = [] } = useFolders(selectedAccountId);
  const foldersByAccount = useAllAccountFolders(accounts);
  const pinnedMap = usePinnedMap().data ?? new Map<number, number[]>();
  const togglePin = useTogglePinnedFolder();
  const prefetchMap = usePrefetchFoldersMap().data ?? new Map<number, number[]>();
  const toggleFolderPrefetch = useToggleFolderPrefetch();
  const markFolderRead = useMarkFolderRead();
  const renameFolder = useRenameFolder();
  const deleteFolder = useDeleteFolder();
  const createSubfolder = useCreateSubfolder();
  const syncNow = useSyncNow();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "rename" | "create" | "delete"; folder: Folder } | null
  >(null);
  const inboxEntries = selectInboxes(accounts, foldersByAccount);
  const pinnedGroups = selectPinnedByAccount(accounts, foldersByAccount, pinnedMap);
  const [menu, setMenu] = useState<{ x: number; y: number; folder: Folder } | null>(null);

  const { priority: priorityFolders, rest: restFolders } = partitionPriorityFolders(folders);
  const priorityNodes: FolderNode[] = priorityFolders.map((f) => ({
    segment: f.name,
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

  function handleRefresh() {
    syncNow.mutate();
    setIsRefreshing(true);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => setIsRefreshing(false), 1200);
  }

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  function buildFolderMenuItems(folder: Folder): ContextMenuItem[] {
    const type = folder.folder_type;
    const items: ContextMenuItem[] = [];
    items.push({
      label: "Oznacz jako przeczytane",
      onClick: () => markFolderRead.mutate(folder.id),
    });
    if (type !== "inbox") {
      const pinned = isFolderPinned(pinnedMap, folder.account_id, folder.id);
      items.push({
        label: pinned ? "Odepnij" : "Przypnij",
        onClick: () => togglePin.mutate({ accountId: folder.account_id, folderId: folder.id }),
      });
    }
    if (type === "inbox" || type === "custom") {
      items.push({ label: "Nowy podfolder", onClick: () => setDialog({ kind: "create", folder }) });
    }
    if (type === "custom") {
      items.push({ label: "Zmień nazwę", onClick: () => setDialog({ kind: "rename", folder }) });
      items.push({ label: "Usuń", onClick: () => setDialog({ kind: "delete", folder }) });
    }
    const prefetched = isFolderPrefetched(prefetchMap, folder.account_id, folder.id);
    items.push({
      label: prefetched ? "Nie pobieraj treści offline" : "Pobieraj treść offline",
      onClick: () =>
        toggleFolderPrefetch.mutate({ accountId: folder.account_id, folderId: folder.id }),
    });
    return items;
  }

  function handleFolderContextMenu(event: React.MouseEvent, folder: Folder) {
    const items = buildFolderMenuItems(folder);
    if (items.length === 0) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, folder });
  }

  const headerAccount = accounts.find((a) => a.id === selectedAccountId) ?? accounts[0];
  const visibleSmartFolders = SMART_FOLDER_META.filter((m) => smartFolderVisibility[m.kind]);

  return (
    <aside className="rail">
      <header className="rail__header">
        <div className="rail__brand">
          <img className="rail__logo" src="/brand/logo-icon.svg" alt="" width={32} height={32} />
          <Wordmark className="rail__wordmark" />
        </div>
        <div className="rail__header-actions">
          <button
            type="button"
            className={`rail__refresh${isRefreshing ? " rail__refresh--spinning" : ""}`}
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label="Sprawdź nowe wiadomości"
            title="Sprawdź nowe wiadomości"
          >
            <RefreshCw size={16} />
          </button>
          {headerAccount && (
            <Avatar
              seed={headerAccount.email}
              label={headerAccount.display_name || headerAccount.email}
              size={30}
              variant="account"
            />
          )}
        </div>
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
        {!accountsLoading && inboxEntries.length > 0 && (
          <>
            <div className="rail__section">Inbox</div>
            {inboxEntries.map(({ account, inbox }) => (
              <div
                key={account.id}
                className={`rail__item${selectedFolderId === inbox.id ? " rail__item--active" : ""}`}
                onClick={() => handleFolderClick(inbox.id, account.id)}
              >
                <Avatar
                  seed={account.email}
                  label={account.display_name || account.email}
                  size={18}
                  variant="account"
                />
                <span className="rail__item-label">{account.display_name || account.email}</span>
                {inbox.unread_count > 0 && <span className="rail__count">{inbox.unread_count}</span>}
              </div>
            ))}
          </>
        )}
        {pinnedGroups.map(({ account, folders: pinnedFolders }) => (
          <div key={`pinned-${account.id}`}>
            <div className="rail__subsection">{account.display_name || account.email}</div>
            {pinnedFolders.map((folder) => (
              <div
                key={folder.id}
                className={`rail__item${selectedFolderId === folder.id ? " rail__item--active" : ""}`}
                onClick={() => handleFolderClick(folder.id, account.id)}
                onContextMenu={(event) => handleFolderContextMenu(event, folder)}
              >
                <span className="rail__chevron-spacer" />
                <FolderIcon folderType={folder.folder_type} />
                <span className="rail__item-label">{folder.name}</span>
                {folderBadgeCount(folder) > 0 && <span className="rail__count">{folderBadgeCount(folder)}</span>}
              </div>
            ))}
          </div>
        ))}
        {smartFoldersEnabled && visibleSmartFolders.length > 0 && (
          <>
            <div className="rail__section">Smart Folders</div>
            {visibleSmartFolders.map(({ kind, label }) => {
              const Icon = SMART_FOLDER_ICONS[kind];
              return (
                <div
                  key={kind}
                  className={`rail__item${selectedSmartFolder === kind ? " rail__item--active" : ""}`}
                  onClick={() => setSelectedSmartFolder(kind)}
                >
                  <Icon size={15} className="rail__item-icon" />
                  <span className="rail__item-label">{label}</span>
                </div>
              );
            })}
          </>
        )}
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
                      onFolderContextMenu={handleFolderContextMenu}
                    />
                    <FolderTreeNodes
                      nodes={restTree}
                      depth={0}
                      expanded={expanded}
                      toggle={toggle}
                      selectedFolderId={selectedFolderId}
                      onFolderClick={handleFolderClick}
                      onFolderContextMenu={handleFolderContextMenu}
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
        {headerAccount && prefetchProgress[headerAccount.id] &&
          prefetchProgress[headerAccount.id].done < prefetchProgress[headerAccount.id].total && (
            <div className="rail__prefetch-status" role="status">
              Downloading bodies: {prefetchProgress[headerAccount.id].done} /{" "}
              {prefetchProgress[headerAccount.id].total}
            </div>
          )}
        <button
          type="button"
          className="rail__settings"
          onClick={openSettings}
          aria-label="Open settings"
        >
          <Settings size={16} />
        </button>
      </footer>
      {menu && (
        <RailContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildFolderMenuItems(menu.folder)}
        />
      )}
      {dialog?.kind === "create" && (
        <TextInputDialog
          title="Nowy podfolder"
          placeholder="Nazwa folderu"
          confirmLabel="Utwórz"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            createSubfolder.mutate(
              { parentId: dialog.folder.id, name },
              { onError: (e) => showErrorToast(e instanceof Error ? e.message : String(e)) },
            );
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <TextInputDialog
          title="Zmień nazwę folderu"
          initialValue={dialog.folder.name}
          confirmLabel="Zmień nazwę"
          onCancel={() => setDialog(null)}
          onConfirm={(newName) => {
            renameFolder.mutate(
              { folderId: dialog.folder.id, newName },
              { onError: (e) => showErrorToast(e instanceof Error ? e.message : String(e)) },
            );
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Usuń folder"
          message={`Usunąć folder „${dialog.folder.name}" wraz z zawartością? Tej operacji nie można cofnąć.`}
          confirmLabel="Usuń folder"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            deleteFolder.mutate(dialog.folder.id, { onError: (e) => showErrorToast(e instanceof Error ? e.message : String(e)) });
            setDialog(null);
          }}
        />
      )}
      <ErrorToast />
    </aside>
  );
}
