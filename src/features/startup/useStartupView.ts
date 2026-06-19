import { useEffect, useRef, useState } from "react";
import { useAccounts, useFolders } from "../../ipc/queries";
import { useUiStore } from "../../app/store";

export function useStartupView() {
  const { data: accounts } = useAccounts();
  const generalHydrated = useUiStore((s) => s.generalHydrated);
  const defaultAccountId = useUiStore((s) => s.defaultAccountId);
  const selectedAccountId = useUiStore((s) => s.selectedAccountId);
  const selectedFolderId = useUiStore((s) => s.selectedFolderId);
  const selectedSmartFolder = useUiStore((s) => s.selectedSmartFolder);
  const selectedLabelId = useUiStore((s) => s.selectedLabelId);
  const setSelectedAccountId = useUiStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useUiStore((s) => s.setSelectedFolderId);

  const phase = useRef<"idle" | "account-set" | "done">("idle");
  const [bootAccountId, setBootAccountId] = useState<number | null>(null);
  const { data: folders } = useFolders(bootAccountId);

  useEffect(() => {
    if (phase.current !== "idle") return;
    if (!generalHydrated) return;
    if (!accounts) return;
    const hasSelection =
      selectedAccountId !== null ||
      selectedFolderId !== null ||
      selectedSmartFolder !== null ||
      selectedLabelId !== null;
    if (hasSelection) {
      phase.current = "done";
      return;
    }
    if (accounts.length === 0) return;
    const explicit = defaultAccountId
      ? accounts.find((a) => String(a.id) === defaultAccountId)
      : undefined;
    const resolved = explicit ?? [...accounts].sort((a, b) => a.position - b.position)[0];
    phase.current = "account-set";
    setBootAccountId(resolved.id);
    setSelectedAccountId(resolved.id);
  }, [
    generalHydrated,
    accounts,
    defaultAccountId,
    selectedAccountId,
    selectedFolderId,
    selectedSmartFolder,
    selectedLabelId,
    setSelectedAccountId,
  ]);

  useEffect(() => {
    if (phase.current !== "account-set") return;
    if (!folders) return;
    const inbox = folders.find((f) => f.folder_type === "inbox");
    if (inbox) setSelectedFolderId(inbox.id);
    phase.current = "done";
  }, [folders, setSelectedFolderId]);
}
