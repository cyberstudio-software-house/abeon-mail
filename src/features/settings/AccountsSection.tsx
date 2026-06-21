import { useEffect, useState } from "react";
import { ChevronUp, ChevronDown, Pencil, Trash2 } from "lucide-react";
import {
  useAccounts,
  useReorderAccounts,
  useRemoveAccount,
  useBeginReauth,
  useUpdateAccount,
  useAccountEndpoints,
  useImageAutoload,
  useSetImageAutoload,
  useAccountPrefetch,
  useSetAccountPrefetch,
  usePrefetchFoldersMap,
  useToggleFolderPrefetch,
  useFolders,
} from "../../ipc/queries";
import { isFolderPrefetched } from "../mailbox/prefetch";
import { decodeImapUtf7 } from "../mailbox/folder-tree";
import { Avatar } from "../../shared/appearance/Avatar";
import { AddAccountWizard } from "../accounts/AddAccountWizard";
import type { Account, Endpoints, Folder } from "../../ipc/bindings";

function AccountEditForm({ account, onClose }: { account: Account; onClose: () => void }) {
  const isImap = account.provider_type === "imap_password";
  const { data: endpoints } = useAccountEndpoints(isImap ? account.id : null);
  const updateAccount = useUpdateAccount();

  const [displayName, setDisplayName] = useState(account.display_name);
  const [form, setForm] = useState<Endpoints | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (endpoints) setForm(endpoints);
  }, [endpoints]);

  function setField<K extends keyof Endpoints>(key: K, value: Endpoints[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function handleSave() {
    setError(null);
    try {
      await updateAccount.mutateAsync({
        accountId: account.id,
        displayName: displayName.trim() || account.email,
        endpoints: isImap ? form : null,
        password: isImap && password ? password : null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const saveDisabled = updateAccount.isPending || (isImap && form == null);

  return (
    <div className="accounts-settings__edit">
      <label className="accounts-settings__field">
        <span>Display name</span>
        <input
          type="text"
          aria-label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>

      {isImap && (
        <>
          {form == null ? (
            <p className="accounts-settings__hint">Loading server settings…</p>
          ) : (
            <>
              <label className="accounts-settings__field">
                <span>IMAP host</span>
                <input
                  type="text"
                  aria-label="IMAP host"
                  value={form.imap_host}
                  onChange={(e) => setField("imap_host", e.target.value)}
                />
              </label>
              <div className="accounts-settings__field-row">
                <label className="accounts-settings__field">
                  <span>IMAP port</span>
                  <input
                    type="number"
                    aria-label="IMAP port"
                    value={form.imap_port}
                    onChange={(e) => setField("imap_port", Number(e.target.value))}
                  />
                </label>
                <label className="accounts-settings__check">
                  <input
                    type="checkbox"
                    aria-label="IMAP TLS"
                    checked={form.imap_tls}
                    onChange={(e) => setField("imap_tls", e.target.checked)}
                  />
                  <span>TLS</span>
                </label>
              </div>
              <label className="accounts-settings__field">
                <span>SMTP host</span>
                <input
                  type="text"
                  aria-label="SMTP host"
                  value={form.smtp_host}
                  onChange={(e) => setField("smtp_host", e.target.value)}
                />
              </label>
              <div className="accounts-settings__field-row">
                <label className="accounts-settings__field">
                  <span>SMTP port</span>
                  <input
                    type="number"
                    aria-label="SMTP port"
                    value={form.smtp_port}
                    onChange={(e) => setField("smtp_port", Number(e.target.value))}
                  />
                </label>
                <label className="accounts-settings__check">
                  <input
                    type="checkbox"
                    aria-label="SMTP TLS"
                    checked={form.smtp_tls}
                    onChange={(e) => setField("smtp_tls", e.target.checked)}
                  />
                  <span>TLS</span>
                </label>
              </div>
              <label className="accounts-settings__field">
                <span>Password</span>
                <input
                  type="password"
                  aria-label="Password"
                  placeholder="Leave blank to keep current"
                  value={password}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </>
          )}
        </>
      )}

      {error && <p className="accounts-settings__error">{error}</p>}

      <div className="accounts-settings__edit-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="accounts-settings__primary"
          disabled={saveDisabled}
          onClick={handleSave}
        >
          {updateAccount.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function AccountImageToggle({ accountId, email }: { accountId: number; email: string }) {
  const { data: autoload = false } = useImageAutoload(accountId);
  const setAutoload = useSetImageAutoload();

  return (
    <div className="appearance-toggle accounts-settings__images">
      <div className="appearance-toggle__text">
        <div className="appearance-toggle__label">Always load remote images</div>
        <div className="appearance-toggle__hint">
          When off, images stay blocked until you click “Load images”
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={autoload}
        aria-label={`Always load remote images for ${email}`}
        className={`switch${autoload ? " switch--on" : ""}`}
        onClick={() => setAutoload.mutate({ accountId, value: !autoload })}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}

function PrefetchFoldersModal({
  accountId,
  email,
  folders,
  prefetchMap,
  onToggle,
  onClose,
}: {
  accountId: number;
  email: string;
  folders: Folder[];
  prefetchMap: Map<number, number[]>;
  onToggle: (folderId: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedCount = prefetchMap.get(accountId)?.length ?? 0;

  return (
    <div className="prefetch-modal__overlay" role="presentation" onClick={onClose}>
      <div
        className="prefetch-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Offline folders for ${email}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="prefetch-modal__header">
          <div>
            <div className="prefetch-modal__title">Folders to download offline</div>
            <div className="prefetch-modal__sub">{email}</div>
          </div>
          <button
            type="button"
            className="prefetch-modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        {folders.length === 0 ? (
          <p className="prefetch-modal__empty">No folders for this account yet.</p>
        ) : (
          <ul className="prefetch-modal__list">
            {folders.map((folder) => {
              const name = decodeImapUtf7(folder.name);
              return (
                <li key={folder.id}>
                  <label className="prefetch-modal__check">
                    <input
                      type="checkbox"
                      aria-label={`Prefetch ${name}`}
                      checked={isFolderPrefetched(prefetchMap, accountId, folder.id)}
                      onChange={() => onToggle(folder.id)}
                    />
                    <span>{name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <footer className="prefetch-modal__footer">
          <span className="prefetch-modal__count">{selectedCount} selected</span>
          <button type="button" className="prefetch-modal__done" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function AccountPrefetchControls({ accountId, email }: { accountId: number; email: string }) {
  const { data: enabled = false } = useAccountPrefetch(accountId);
  const setEnabled = useSetAccountPrefetch();
  const { data: folders = [] } = useFolders(accountId);
  const prefetchMap = usePrefetchFoldersMap().data ?? new Map<number, number[]>();
  const toggleFolder = useToggleFolderPrefetch();
  const [modalOpen, setModalOpen] = useState(false);

  const selectedCount = prefetchMap.get(accountId)?.length ?? 0;

  return (
    <div className="appearance-toggle accounts-settings__images">
      <div className="appearance-toggle__text">
        <div className="appearance-toggle__label">Download message bodies for offline</div>
        <div className="appearance-toggle__hint">
          Bodies for the selected folders download in the background after headers
        </div>
      </div>
      <div className="accounts-settings__prefetch-actions">
        {enabled && (
          <button
            type="button"
            className="accounts-settings__prefetch-manage"
            onClick={() => setModalOpen(true)}
          >
            Folders{selectedCount > 0 ? ` (${selectedCount})` : ""}
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Download message bodies for offline for ${email}`}
          className={`switch${enabled ? " switch--on" : ""}`}
          onClick={() => setEnabled.mutate({ accountId, value: !enabled })}
        >
          <span className="switch__knob" />
        </button>
      </div>

      {modalOpen && (
        <PrefetchFoldersModal
          accountId={accountId}
          email={email}
          folders={folders}
          prefetchMap={prefetchMap}
          onToggle={(folderId) => toggleFolder.mutate({ accountId, folderId })}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

export function AccountsSection() {
  const { data: accounts = [] } = useAccounts();
  const reorderAccounts = useReorderAccounts();
  const removeAccount = useRemoveAccount();
  const beginReauth = useBeginReauth();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= accounts.length) return;
    const ids = accounts.map((a) => a.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorderAccounts.mutate(ids);
  }

  return (
    <div className="settings-section accounts-settings">
      <ul className="accounts-settings__list">
        {accounts.map((account, index) => (
          <li key={account.id} className="accounts-settings__item">
            <div className="accounts-settings__row">
              <div className="accounts-settings__order">
                <button
                  type="button"
                  aria-label={`Move ${account.display_name || account.email} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${account.display_name || account.email} down`}
                  disabled={index === accounts.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown size={15} />
                </button>
              </div>
              <Avatar
                seed={account.email}
                label={account.display_name || account.email}
                size={28}
              />
              <div className="accounts-settings__identity">
                <span className="accounts-settings__name">
                  {account.display_name || account.email}
                </span>
                <span className="accounts-settings__email">{account.email}</span>
              </div>
              {account.requires_reauth && account.provider_type === "google_oauth" && (
                <button
                  type="button"
                  className="accounts-settings__reconnect"
                  onClick={() => beginReauth.mutate(account.id)}
                >
                  ⚠ Reconnect
                </button>
              )}
              <button
                type="button"
                aria-label={`Edit ${account.display_name || account.email}`}
                onClick={() => setEditingId(editingId === account.id ? null : account.id)}
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                aria-label={`Remove ${account.display_name || account.email}`}
                onClick={() => setConfirmRemoveId(account.id)}
              >
                <Trash2 size={15} />
              </button>
            </div>

            <AccountImageToggle accountId={account.id} email={account.email} />
            <AccountPrefetchControls accountId={account.id} email={account.email} />

            {editingId === account.id && (
              <AccountEditForm account={account} onClose={() => setEditingId(null)} />
            )}

            {confirmRemoveId === account.id && (
              <div className="accounts-settings__confirm">
                <span>
                  Permanently remove this account and all locally cached messages?
                </span>
                <div className="accounts-settings__edit-actions">
                  <button type="button" onClick={() => setConfirmRemoveId(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="accounts-settings__danger"
                    onClick={() => {
                      removeAccount.mutate(account.id);
                      setConfirmRemoveId(null);
                      if (editingId === account.id) setEditingId(null);
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {accounts.length === 0 && (
        <p className="accounts-settings__hint">No accounts yet.</p>
      )}

      <button
        type="button"
        className="accounts-settings__primary"
        onClick={() => setWizardOpen(true)}
      >
        Add account
      </button>

      {wizardOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 300,
          }}
        >
          <AddAccountWizard
            onClose={() => setWizardOpen(false)}
            onAdded={() => setWizardOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
