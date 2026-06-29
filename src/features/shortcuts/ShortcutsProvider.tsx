import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { commands } from "../../ipc/bindings";
import { useStartReply, useSetFlag, useSetSeen, useArchive, useDelete } from "../../ipc/queries";
import { seenIdsForBulk } from "../reader/seen";
import { useUiStore } from "../../app/store";
import { resolveBindings, parseShortcutSettings, SHORTCUT_KEYS, type Profile } from "./bindings";
import { type ActionId } from "./registry";
import { useKeyboardEngine } from "./useKeyboardEngine";
import { CommandPalette } from "./CommandPalette";
import { CheatSheet } from "./CheatSheet";
import { LabelPicker } from "../labels/LabelPicker";
import { SnoozePicker } from "../snooze/SnoozePicker";
import { FolderPicker } from "../reader/FolderPicker";
import { UndoBar } from "./UndoBar";
import { resolveSelectedMessageIds } from "../../shared/selection/resolveMessageIds";

export type ShortcutsContextValue = {
  profile: Profile;
  resolved: Record<ActionId, string | null>;
  overrides: Record<string, string | null>;
  setProfile: (p: Profile) => void;
  setBinding: (id: ActionId, binding: string | null) => void;
  resetBinding: (id: ActionId) => void;
};

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

function persistOverrides(overrides: Record<string, string | null>) {
  void commands.setSetting(SHORTCUT_KEYS.overrides, JSON.stringify(overrides)).catch(() => undefined);
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const profile = useUiStore((s) => s.shortcutProfile);
  const overrides = useUiStore((s) => s.shortcutOverrides);
  const hydrateShortcuts = useUiStore((s) => s.hydrateShortcuts);
  const setShortcutProfile = useUiStore((s) => s.setShortcutProfile);
  const setShortcutOverride = useUiStore((s) => s.setShortcutOverride);
  const resetShortcut = useUiStore((s) => s.resetShortcut);

  const queryClient = useQueryClient();
  const startReply = useStartReply();
  const setFlag = useSetFlag();
  const setSeenBulk = useSetSeen();
  const archive = useArchive();
  const del = useDelete();

  useEffect(() => {
    let active = true;
    commands
      .getSettings()
      .then((res) => {
        if (active && res.status === "ok") hydrateShortcuts(parseShortcutSettings(res.data));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [hydrateShortcuts]);

  const resolved = useMemo(() => resolveBindings(profile, overrides), [profile, overrides]);

  const move = useCallback((delta: number) => {
    const s = useUiStore.getState();
    const ids = s.visibleMessageIds;
    if (ids.length === 0) return;
    const current = s.selectMode === "thread" ? s.selectedThreadId : s.selectedMessageId;
    const idx = current == null ? -1 : ids.indexOf(current);
    const nextIdx = idx < 0 ? 0 : Math.min(Math.max(idx + delta, 0), ids.length - 1);
    const next = ids[nextIdx];
    if (next == null) return;
    if (s.selectMode === "thread") s.setSelectedThreadId(next);
    else s.setSelectedMessageId(next);
  }, []);

  const jumpTo = useCallback((edge: "first" | "last") => {
    const s = useUiStore.getState();
    const ids = s.visibleMessageIds;
    if (ids.length === 0) return;
    const id = edge === "first" ? ids[0] : ids[ids.length - 1];
    if (s.selectMode === "thread") s.setSelectedThreadId(id);
    else s.setSelectedMessageId(id);
  }, []);

  const doReply = useCallback(
    async (mode: "reply" | "reply_all" | "forward") => {
      const s = useUiStore.getState();
      if (s.replyTargetId == null) return;
      const prefill = await startReply.mutateAsync({ messageId: s.replyTargetId, mode });
      s.openComposer(null, prefill);
    },
    [startReply]
  );

  const setSeen = useCallback(
    (value: boolean) => {
      const s = useUiStore.getState();
      if (s.selectedThreadId == null) return;
      const messages = queryClient.getQueryData<{ id: number; seen: boolean }[]>([
        "thread-messages",
        s.selectedThreadId,
      ]);
      const ids = seenIdsForBulk(messages, value);
      if (ids.length === 0) return;
      setSeenBulk.mutate({ ids, value });
    },
    [setSeenBulk, queryClient]
  );

  const doMove = useCallback(
    (kind: "archive" | "delete") => {
      const s = useUiStore.getState();
      if (s.selectedRowIds.length >= 1) {
        const removedRowIds = s.selectedRowIds;
        void resolveSelectedMessageIds().then((ids) => {
          if (ids.length === 0) return;
          if (kind === "archive") archive.mutate({ messageIds: ids });
          else del.mutate({ messageIds: ids });
          s.showUndoToast(kind, ids);
          s.advanceSelectionAfter(removedRowIds);
        });
        return;
      }
      if (s.selectedThreadId != null) {
        const messages = queryClient.getQueryData<{ id: number }[]>(["thread-messages", s.selectedThreadId]);
        const ids = (messages ?? []).map((m) => m.id);
        if (ids.length === 0) return;
        if (kind === "archive") archive.mutate({ messageIds: ids });
        else del.mutate({ messageIds: ids });
        s.showUndoToast(kind, ids);
        s.advanceSelectionAfter([s.selectedThreadId]);
      }
    },
    [archive, del, queryClient]
  );

  const toggleFlag = useCallback(() => {
    const s = useUiStore.getState();
    if (s.replyTargetId == null || s.selectedThreadId == null) return;
    const messages = queryClient.getQueryData<{ id: number; flagged: boolean }[]>([
      "thread-messages",
      s.selectedThreadId,
    ]);
    const current = messages?.find((m) => m.id === s.replyTargetId)?.flagged ?? false;
    setFlag.mutate({ messageId: s.replyTargetId, flag: "flagged", value: !current });
  }, [setFlag, queryClient]);

  const handlers = useMemo<Partial<Record<ActionId, () => void>>>(() => {
    return {
      "command-palette": () => useUiStore.getState().togglePalette(),
      "cheat-sheet": () => useUiStore.getState().toggleCheatSheet(),
      compose: () => useUiStore.getState().openComposer(null),
      "go-inbox": () => useUiStore.getState().setSelectedSmartFolder("all_inboxes"),
      "go-starred": () => useUiStore.getState().setSelectedSmartFolder("flagged"),
      "open-settings": () => useUiStore.getState().openSettings(),
      search: () => useUiStore.getState().focusSearch?.(),
      "next-message": () => move(1),
      "prev-message": () => move(-1),
      "next-message-arrow": () => move(1),
      "prev-message-arrow": () => move(-1),
      "first-message": () => jumpTo("first"),
      "last-message": () => jumpTo("last"),
      reply: () => void doReply("reply"),
      "reply-all": () => void doReply("reply_all"),
      forward: () => void doReply("forward"),
      "back-to-list": () => useUiStore.getState().setSelectedThreadId(null),
      "toggle-flag": () => toggleFlag(),
      "mark-read": () => setSeen(true),
      "mark-unread": () => setSeen(false),
      "send-message": () => useUiStore.getState().composerSend?.(),
      "close-composer": () => useUiStore.getState().closeComposer(),
      label: () => {
        const s = useUiStore.getState();
        if (s.selectedRowIds.length >= 1) {
          void resolveSelectedMessageIds().then((ids) => { if (ids.length) s.openLabelPicker(ids); });
        } else if (s.replyTargetId != null) {
          s.openLabelPicker([s.replyTargetId]);
        }
      },
      snooze: () => {
        const s = useUiStore.getState();
        if (s.selectedRowIds.length >= 1) {
          void resolveSelectedMessageIds().then((ids) => { if (ids.length) s.openSnoozePicker(ids); });
        } else if (s.replyTargetId != null) {
          s.openSnoozePicker([s.replyTargetId]);
        }
      },
      archive: () => doMove("archive"),
      delete: () => doMove("delete"),
    };
  }, [move, jumpTo, doReply, toggleFlag, setSeen, doMove]);

  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useKeyboardEngine({
    getResolved: useCallback(() => resolvedRef.current, []),
    getHandlers: useCallback(() => handlersRef.current, []),
    getContext: useCallback(() => {
      const s = useUiStore.getState();
      if (s.composer.open) return "composer";
      if (s.selectedThreadId != null) return "reader";
      return "list";
    }, []),
  });

  const value = useMemo<ShortcutsContextValue>(
    () => ({
      profile,
      resolved,
      overrides,
      setProfile: (p) => {
        setShortcutProfile(p);
        void commands.setSetting(SHORTCUT_KEYS.profile, p).catch(() => undefined);
      },
      setBinding: (id, binding) => {
        setShortcutOverride(id, binding);
        persistOverrides({ ...useUiStore.getState().shortcutOverrides });
      },
      resetBinding: (id) => {
        resetShortcut(id);
        persistOverrides({ ...useUiStore.getState().shortcutOverrides });
      },
    }),
    [profile, resolved, overrides, setShortcutProfile, setShortcutOverride, resetShortcut]
  );

  return (
    <ShortcutsContext.Provider value={value}>
      {children}
      <CommandPalette />
      <CheatSheet />
      <LabelPicker />
      <SnoozePicker />
      <FolderPicker />
      <UndoBar />
    </ShortcutsContext.Provider>
  );
}

export function useShortcuts(): ShortcutsContextValue {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) throw new Error("useShortcuts must be used within ShortcutsProvider");
  return ctx;
}
