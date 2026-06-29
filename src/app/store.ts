import { create } from "zustand";
import type { OutgoingMessage, SmartFolderKind } from "../ipc/bindings";
import type { ThemeMode } from "../shared/theme/theme";
import type { Profile } from "../features/shortcuts/bindings";
import {
  DEFAULT_APPEARANCE,
  type AppearanceFields,
  type Density,
} from "../shared/appearance/appearance";
import type { SmartFolderVisibility } from "../shared/smartFolders";
import { DEFAULT_NOTIFICATIONS } from "../shared/notifications/notifications";
import {
  DEFAULT_GENERAL,
  type GeneralFields,
  type TimeFormat,
  type MarkReadMode,
  type ThreadOrder,
  type ListSortDir,
} from "../shared/general/general";
import {
  DEFAULT_SNOOZE_CONFIG,
  type SnoozeConfig,
} from "../shared/snooze/snooze";
import { selectNextAfterRemoval } from "../shared/selection/selectNextAfterRemoval";

export type { Density };
export type { TimeFormat };
export type { MarkReadMode };
export type { ThreadOrder };
export type { ListSortDir };

type ComposerState = {
  open: boolean;
  draftId: number | null;
  prefill: OutgoingMessage | null;
};

export type UiState = {
  selectedAccountId: number | null;
  selectedFolderId: number | null;
  selectedMessageId: number | null;
  selectedThreadId: number | null;
  selectedSmartFolder: SmartFolderKind | null;
  selectedLabelId: number | null;
  theme: ThemeMode;
  accent: string;
  density: Density;
  showPreview: boolean;
  showAvatars: boolean;
  smartFoldersEnabled: boolean;
  smartFolderVisibility: SmartFolderVisibility;
  notificationsEnabled: boolean;
  badgeEnabled: boolean;
  trayEnabled: boolean;
  prefetchProgress: Record<number, { done: number; total: number }>;
  setPrefetchProgress: (accountId: number, done: number, total: number) => void;
  sendingCount: number;
  lastSentAt: number | null;
  sendWatchdogs: ReturnType<typeof setTimeout>[];
  markSendStarted: () => void;
  markSendSucceeded: () => void;
  markSendFailed: () => void;
  defaultAccountId: string;
  timeFormat: TimeFormat;
  markReadMode: MarkReadMode;
  markReadDelaySeconds: number;
  threadOrder: ThreadOrder;
  listSortDir: ListSortDir;
  listFilterSender: string;
  listFilterSubject: string;
  listFilterAttachmentsOnly: boolean;
  generalHydrated: boolean;
  markUnreadEpoch: number;
  snoozeMorningHour: number;
  snoozeLaterTodayHours: number;
  snoozeWeekendDay: number;
  snoozeWeekStartDay: number;
  settingsOpen: boolean;
  composer: ComposerState;
  visibleMessageIds: number[];
  selectMode: "thread" | "message";
  replyTargetId: number | null;
  composerSend: (() => void) | null;
  paletteOpen: boolean;
  cheatSheetOpen: boolean;
  shortcutProfile: Profile;
  shortcutOverrides: Record<string, string | null>;
  searchQuery: string;
  searchActive: boolean;
  focusSearch: (() => void) | null;
  selectedRowIds: number[];
  selectionAnchorId: number | null;
  rowAccounts: Record<number, number>;
  selectRow: (id: number) => void;
  toggleRow: (id: number) => void;
  selectRangeTo: (id: number) => void;
  advanceSelectionAfter: (removedRowIds: number[]) => void;
  labelPickerOpen: boolean;
  labelPickerTargetIds: number[];
  snoozePickerOpen: boolean;
  snoozePickerTargetIds: number[];
  folderPickerOpen: boolean;
  folderPickerTargetIds: number[];
  folderPickerAccountId: number | null;
  openFolderPicker: (ids: number[], accountId: number) => void;
  closeFolderPicker: () => void;
  undoToast: { kind: "archive" | "delete" | "move"; messageIds: number[] } | null;
  showUndoToast: (kind: "archive" | "delete" | "move", messageIds: number[]) => void;
  clearUndoToast: () => void;
  errorToast: string | null;
  showErrorToast: (message: string) => void;
  clearErrorToast: () => void;
  setSelectedAccountId: (id: number | null) => void;
  setSelectedFolderId: (id: number | null) => void;
  setSelectedMessageId: (id: number | null) => void;
  setSelectedThreadId: (id: number | null) => void;
  setSelectedSmartFolder: (kind: SmartFolderKind | null) => void;
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: string) => void;
  setDensity: (density: Density) => void;
  setShowPreview: (value: boolean) => void;
  setShowAvatars: (value: boolean) => void;
  setSmartFoldersEnabled: (value: boolean) => void;
  setSmartFolderVisible: (kind: SmartFolderKind, visible: boolean) => void;
  hydrateAppearance: (partial: Partial<AppearanceFields>) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setBadgeEnabled: (value: boolean) => void;
  setTrayEnabled: (value: boolean) => void;
  hydrateNotifications: (partial: Partial<{ notificationsEnabled: boolean; badgeEnabled: boolean; trayEnabled: boolean }>) => void;
  setDefaultAccountId: (value: string) => void;
  setTimeFormat: (value: TimeFormat) => void;
  setMarkReadMode: (value: MarkReadMode) => void;
  setMarkReadDelaySeconds: (value: number) => void;
  setThreadOrder: (value: ThreadOrder) => void;
  setListSortDir: (value: ListSortDir) => void;
  setListFilterSender: (value: string) => void;
  setListFilterSubject: (value: string) => void;
  setListFilterAttachmentsOnly: (value: boolean) => void;
  clearListFilters: () => void;
  hydrateGeneral: (partial: Partial<GeneralFields>) => void;
  setSnoozeMorningHour: (value: number) => void;
  setSnoozeLaterTodayHours: (value: number) => void;
  setSnoozeWeekendDay: (value: number) => void;
  setSnoozeWeekStartDay: (value: number) => void;
  hydrateSnooze: (partial: Partial<SnoozeConfig>) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openComposer: (draftId: number | null, prefill?: OutgoingMessage | null) => void;
  closeComposer: () => void;
  setListContext: (ids: number[], mode: "thread" | "message", accounts?: Record<number, number>) => void;
  setReplyTargetId: (id: number | null) => void;
  setComposerSend: (fn: (() => void) | null) => void;
  togglePalette: () => void;
  closePalette: () => void;
  toggleCheatSheet: () => void;
  closeCheatSheet: () => void;
  setShortcutProfile: (p: Profile) => void;
  setShortcutOverride: (id: string, binding: string | null) => void;
  resetShortcut: (id: string) => void;
  hydrateShortcuts: (partial: { profile?: Profile; overrides?: Record<string, string | null> }) => void;
  setSearchQuery: (q: string) => void;
  clearSearch: () => void;
  setFocusSearch: (fn: (() => void) | null) => void;
  setSelectedLabelId: (id: number | null) => void;
  clearSelection: () => void;
  openLabelPicker: (ids: number[]) => void;
  closeLabelPicker: () => void;
  openSnoozePicker: (ids: number[]) => void;
  closeSnoozePicker: () => void;
  bumpMarkUnreadEpoch: () => void;
};

export const SEND_WATCHDOG_MS = 300000;

export const useUiStore = create<UiState>((set, get) => ({
  selectedAccountId: null,
  selectedFolderId: null,
  selectedMessageId: null,
  selectedThreadId: null,
  selectedSmartFolder: null,
  selectedLabelId: null,
  theme: DEFAULT_APPEARANCE.theme,
  accent: DEFAULT_APPEARANCE.accent,
  density: DEFAULT_APPEARANCE.density,
  showPreview: DEFAULT_APPEARANCE.showPreview,
  showAvatars: DEFAULT_APPEARANCE.showAvatars,
  smartFoldersEnabled: DEFAULT_APPEARANCE.smartFoldersEnabled,
  smartFolderVisibility: { ...DEFAULT_APPEARANCE.smartFolderVisibility },
  notificationsEnabled: DEFAULT_NOTIFICATIONS.notificationsEnabled,
  badgeEnabled: DEFAULT_NOTIFICATIONS.badgeEnabled,
  trayEnabled: DEFAULT_NOTIFICATIONS.trayEnabled,
  prefetchProgress: {},
  sendingCount: 0,
  lastSentAt: null,
  sendWatchdogs: [],
  defaultAccountId: DEFAULT_GENERAL.defaultAccountId,
  timeFormat: DEFAULT_GENERAL.timeFormat,
  markReadMode: DEFAULT_GENERAL.markReadMode,
  markReadDelaySeconds: DEFAULT_GENERAL.markReadDelaySeconds,
  threadOrder: DEFAULT_GENERAL.threadOrder,
  listSortDir: DEFAULT_GENERAL.listSortDir,
  listFilterSender: "",
  listFilterSubject: "",
  listFilterAttachmentsOnly: false,
  generalHydrated: false,
  markUnreadEpoch: 0,
  snoozeMorningHour: DEFAULT_SNOOZE_CONFIG.morningHour,
  snoozeLaterTodayHours: DEFAULT_SNOOZE_CONFIG.laterTodayHours,
  snoozeWeekendDay: DEFAULT_SNOOZE_CONFIG.weekendDay,
  snoozeWeekStartDay: DEFAULT_SNOOZE_CONFIG.weekStartDay,
  settingsOpen: false,
  composer: { open: false, draftId: null, prefill: null },
  visibleMessageIds: [],
  selectMode: "thread",
  replyTargetId: null,
  composerSend: null,
  paletteOpen: false,
  cheatSheetOpen: false,
  shortcutProfile: "default",
  shortcutOverrides: {},
  searchQuery: "",
  searchActive: false,
  focusSearch: null,
  selectedRowIds: [],
  selectionAnchorId: null,
  rowAccounts: {},
  labelPickerOpen: false,
  labelPickerTargetIds: [],
  snoozePickerOpen: false,
  snoozePickerTargetIds: [],
  folderPickerOpen: false,
  folderPickerTargetIds: [],
  folderPickerAccountId: null,
  openFolderPicker: (ids, accountId) =>
    set({ folderPickerOpen: true, folderPickerTargetIds: ids, folderPickerAccountId: accountId }),
  closeFolderPicker: () =>
    set({ folderPickerOpen: false, folderPickerTargetIds: [], folderPickerAccountId: null }),
  undoToast: null,
  showUndoToast: (kind, messageIds) => set({ undoToast: { kind, messageIds } }),
  clearUndoToast: () => set({ undoToast: null }),
  errorToast: null,
  showErrorToast: (message) => set({ errorToast: message }),
  clearErrorToast: () => set({ errorToast: null }),
  setSelectedAccountId: (id) =>
    set({ selectedAccountId: id, selectedSmartFolder: null, selectedLabelId: null, selectedMessageId: null, searchQuery: "", searchActive: false, selectedRowIds: [], selectionAnchorId: null }),
  setSelectedFolderId: (id) =>
    set({ selectedFolderId: id, selectedSmartFolder: null, selectedLabelId: null, selectedMessageId: null, searchQuery: "", searchActive: false, selectedRowIds: [], selectionAnchorId: null }),
  setSelectedMessageId: (id) =>
    set({ selectedMessageId: id, selectedRowIds: id == null ? [] : [id], selectionAnchorId: id }),
  setSelectedThreadId: (id) =>
    set({ selectedThreadId: id, selectedRowIds: id == null ? [] : [id], selectionAnchorId: id }),
  setSelectedSmartFolder: (kind) =>
    set({
      selectedSmartFolder: kind,
      selectedLabelId: null,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
      selectedMessageId: null,
      searchQuery: "",
      searchActive: false,
      selectedRowIds: [],
      selectionAnchorId: null,
    }),
  setTheme: (theme) => set({ theme }),
  setAccent: (accent) => set({ accent }),
  setDensity: (density) => set({ density }),
  setShowPreview: (showPreview) => set({ showPreview }),
  setShowAvatars: (showAvatars) => set({ showAvatars }),
  setSmartFoldersEnabled: (smartFoldersEnabled) => set({ smartFoldersEnabled }),
  setSmartFolderVisible: (kind, visible) =>
    set((s) => ({ smartFolderVisibility: { ...s.smartFolderVisibility, [kind]: visible } })),
  hydrateAppearance: (partial) => set(partial),
  setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
  setBadgeEnabled: (badgeEnabled) => set({ badgeEnabled }),
  setTrayEnabled: (trayEnabled) => set({ trayEnabled }),
  setPrefetchProgress: (accountId, done, total) =>
    set((s) => ({ prefetchProgress: { ...s.prefetchProgress, [accountId]: { done, total } } })),
  markSendStarted: () => {
    const handle = setTimeout(() => {
      set((s) =>
        s.sendingCount <= 0
          ? {}
          : {
              sendingCount: s.sendingCount - 1,
              sendWatchdogs: s.sendWatchdogs.filter((h) => h !== handle),
            },
      );
    }, SEND_WATCHDOG_MS);
    set((s) => ({ sendingCount: s.sendingCount + 1, sendWatchdogs: [...s.sendWatchdogs, handle] }));
  },
  markSendSucceeded: () => {
    const first = get().sendWatchdogs[0];
    if (first) clearTimeout(first);
    set((s) => ({
      sendingCount: Math.max(0, s.sendingCount - 1),
      sendWatchdogs: s.sendWatchdogs.slice(1),
      lastSentAt: Date.now(),
    }));
  },
  markSendFailed: () => {
    const first = get().sendWatchdogs[0];
    if (first) clearTimeout(first);
    set((s) => ({
      sendingCount: Math.max(0, s.sendingCount - 1),
      sendWatchdogs: s.sendWatchdogs.slice(1),
    }));
  },
  hydrateNotifications: (partial) => set(partial),
  setDefaultAccountId: (defaultAccountId) => set({ defaultAccountId }),
  setTimeFormat: (timeFormat) => set({ timeFormat }),
  setMarkReadMode: (markReadMode) => set({ markReadMode }),
  setMarkReadDelaySeconds: (markReadDelaySeconds) => set({ markReadDelaySeconds }),
  setThreadOrder: (threadOrder) => set({ threadOrder }),
  setListSortDir: (listSortDir) => set({ listSortDir }),
  setListFilterSender: (listFilterSender) => set({ listFilterSender }),
  setListFilterSubject: (listFilterSubject) => set({ listFilterSubject }),
  setListFilterAttachmentsOnly: (listFilterAttachmentsOnly) => set({ listFilterAttachmentsOnly }),
  clearListFilters: () =>
    set({ listFilterSender: "", listFilterSubject: "", listFilterAttachmentsOnly: false }),
  hydrateGeneral: (partial) => set({ ...partial, generalHydrated: true }),
  setSnoozeMorningHour: (snoozeMorningHour) => set({ snoozeMorningHour }),
  setSnoozeLaterTodayHours: (snoozeLaterTodayHours) => set({ snoozeLaterTodayHours }),
  setSnoozeWeekendDay: (snoozeWeekendDay) => set({ snoozeWeekendDay }),
  setSnoozeWeekStartDay: (snoozeWeekStartDay) => set({ snoozeWeekStartDay }),
  hydrateSnooze: (partial) =>
    set((s) => ({
      snoozeMorningHour: partial.morningHour ?? s.snoozeMorningHour,
      snoozeLaterTodayHours: partial.laterTodayHours ?? s.snoozeLaterTodayHours,
      snoozeWeekendDay: partial.weekendDay ?? s.snoozeWeekendDay,
      snoozeWeekStartDay: partial.weekStartDay ?? s.snoozeWeekStartDay,
    })),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openComposer: (draftId, prefill = null) =>
    set({ composer: { open: true, draftId, prefill } }),
  closeComposer: () =>
    set({ composer: { open: false, draftId: null, prefill: null } }),
  setListContext: (ids, mode, accounts = {}) =>
    set({ visibleMessageIds: ids, selectMode: mode, rowAccounts: accounts }),
  setReplyTargetId: (id) => set({ replyTargetId: id }),
  setComposerSend: (fn) => set({ composerSend: fn }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  closePalette: () => set({ paletteOpen: false }),
  toggleCheatSheet: () => set((s) => ({ cheatSheetOpen: !s.cheatSheetOpen })),
  closeCheatSheet: () => set({ cheatSheetOpen: false }),
  setShortcutProfile: (p) => set({ shortcutProfile: p }),
  setShortcutOverride: (id, binding) =>
    set((s) => ({ shortcutOverrides: { ...s.shortcutOverrides, [id]: binding } })),
  resetShortcut: (id) =>
    set((s) => {
      const next = { ...s.shortcutOverrides };
      delete next[id];
      return { shortcutOverrides: next };
    }),
  hydrateShortcuts: (partial) =>
    set((s) => ({
      shortcutProfile: partial.profile ?? s.shortcutProfile,
      shortcutOverrides: partial.overrides ?? s.shortcutOverrides,
    })),
  setSearchQuery: (q) => set({ searchQuery: q, searchActive: q.trim().length > 0, selectedLabelId: null, selectedRowIds: [], selectionAnchorId: null }),
  clearSearch: () => set({ searchQuery: "", searchActive: false, selectedRowIds: [], selectionAnchorId: null }),
  setFocusSearch: (fn) => set({ focusSearch: fn }),
  setSelectedLabelId: (id) =>
    set({
      selectedLabelId: id,
      selectedSmartFolder: null,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
      selectedMessageId: null,
      searchQuery: "",
      searchActive: false,
      selectedRowIds: [],
      selectionAnchorId: null,
    }),
  clearSelection: () =>
    set({ selectedRowIds: [], selectionAnchorId: null }),
  selectRow: (id) =>
    set((s) =>
      s.selectMode === "thread"
        ? { selectedThreadId: id, selectedMessageId: null, selectedRowIds: [id], selectionAnchorId: id }
        : { selectedMessageId: id, selectedThreadId: null, selectedRowIds: [id], selectionAnchorId: id }
    ),
  toggleRow: (id) =>
    set((s) => {
      const has = s.selectedRowIds.includes(id);
      const next = has ? s.selectedRowIds.filter((x) => x !== id) : [...s.selectedRowIds, id];
      if (next.length === 1) {
        return s.selectMode === "thread"
          ? { selectedRowIds: next, selectionAnchorId: next[0], selectedThreadId: next[0], selectedMessageId: null }
          : { selectedRowIds: next, selectionAnchorId: next[0], selectedMessageId: next[0], selectedThreadId: null };
      }
      if (next.length === 0) {
        return { selectedRowIds: next, selectionAnchorId: null, selectedThreadId: null, selectedMessageId: null };
      }
      return { selectedRowIds: next, selectionAnchorId: id };
    }),
  selectRangeTo: (id) =>
    set((s) => {
      const ids = s.visibleMessageIds;
      const anchor = s.selectionAnchorId ?? id;
      const i = ids.indexOf(anchor);
      const j = ids.indexOf(id);
      if (i === -1 || j === -1) {
        return { selectedRowIds: [id], selectionAnchorId: id };
      }
      const [lo, hi] = i <= j ? [i, j] : [j, i];
      const range = ids.slice(lo, hi + 1);
      if (range.length === 1) {
        return s.selectMode === "thread"
          ? { selectedRowIds: range, selectedThreadId: range[0], selectedMessageId: null }
          : { selectedRowIds: range, selectedMessageId: range[0], selectedThreadId: null };
      }
      return { selectedRowIds: range };
    }),
  advanceSelectionAfter: (removedRowIds) =>
    set((s) => {
      const next = selectNextAfterRemoval(s.visibleMessageIds, removedRowIds);
      if (next == null) {
        return { selectedRowIds: [], selectionAnchorId: null, selectedThreadId: null, selectedMessageId: null };
      }
      return s.selectMode === "thread"
        ? { selectedThreadId: next, selectedMessageId: null, selectedRowIds: [next], selectionAnchorId: next }
        : { selectedMessageId: next, selectedThreadId: null, selectedRowIds: [next], selectionAnchorId: next };
    }),
  openLabelPicker: (ids) => set({ labelPickerOpen: true, labelPickerTargetIds: ids }),
  closeLabelPicker: () => set({ labelPickerOpen: false, labelPickerTargetIds: [] }),
  openSnoozePicker: (ids) => set({ snoozePickerOpen: true, snoozePickerTargetIds: ids }),
  closeSnoozePicker: () => set({ snoozePickerOpen: false, snoozePickerTargetIds: [] }),
  bumpMarkUnreadEpoch: () => set((s) => ({ markUnreadEpoch: s.markUnreadEpoch + 1 })),
}));
