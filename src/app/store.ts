import { create } from "zustand";
import type { OutgoingMessage, SmartFolderKind } from "../ipc/bindings";
import type { ThemeMode } from "../shared/theme/theme";
import type { Profile } from "../features/shortcuts/bindings";
import {
  DEFAULT_APPEARANCE,
  type AppearanceFields,
  type Density,
} from "../shared/appearance/appearance";

export type { Density };

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
  selectionActive: boolean;
  selectedMessageIds: number[];
  labelPickerOpen: boolean;
  labelPickerTargetIds: number[];
  snoozePickerOpen: boolean;
  snoozePickerTargetIds: number[];
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
  hydrateAppearance: (partial: Partial<AppearanceFields>) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openComposer: (draftId: number | null, prefill?: OutgoingMessage | null) => void;
  closeComposer: () => void;
  setListContext: (ids: number[], mode: "thread" | "message") => void;
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
  toggleSelectionMode: () => void;
  toggleMessageSelected: (id: number) => void;
  clearSelection: () => void;
  selectAll: (ids: number[]) => void;
  openLabelPicker: (ids: number[]) => void;
  closeLabelPicker: () => void;
  openSnoozePicker: (ids: number[]) => void;
  closeSnoozePicker: () => void;
};

export const useUiStore = create<UiState>((set) => ({
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
  selectionActive: false,
  selectedMessageIds: [],
  labelPickerOpen: false,
  labelPickerTargetIds: [],
  snoozePickerOpen: false,
  snoozePickerTargetIds: [],
  setSelectedAccountId: (id) =>
    set({ selectedAccountId: id, selectedSmartFolder: null, selectedLabelId: null, searchQuery: "", searchActive: false }),
  setSelectedFolderId: (id) =>
    set({ selectedFolderId: id, selectedSmartFolder: null, selectedLabelId: null, searchQuery: "", searchActive: false }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedThreadId: (id) => set({ selectedThreadId: id }),
  setSelectedSmartFolder: (kind) =>
    set({
      selectedSmartFolder: kind,
      selectedLabelId: null,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
      searchQuery: "",
      searchActive: false,
    }),
  setTheme: (theme) => set({ theme }),
  setAccent: (accent) => set({ accent }),
  setDensity: (density) => set({ density }),
  setShowPreview: (showPreview) => set({ showPreview }),
  setShowAvatars: (showAvatars) => set({ showAvatars }),
  hydrateAppearance: (partial) => set(partial),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openComposer: (draftId, prefill = null) =>
    set({ composer: { open: true, draftId, prefill } }),
  closeComposer: () =>
    set({ composer: { open: false, draftId: null, prefill: null } }),
  setListContext: (ids, mode) => set({ visibleMessageIds: ids, selectMode: mode }),
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
  setSearchQuery: (q) => set({ searchQuery: q, searchActive: q.trim().length > 0, selectedLabelId: null }),
  clearSearch: () => set({ searchQuery: "", searchActive: false }),
  setFocusSearch: (fn) => set({ focusSearch: fn }),
  setSelectedLabelId: (id) =>
    set({
      selectedLabelId: id,
      selectedSmartFolder: null,
      selectedAccountId: null,
      selectedFolderId: null,
      selectedThreadId: null,
      searchQuery: "",
      searchActive: false,
      selectionActive: false,
      selectedMessageIds: [],
    }),
  toggleSelectionMode: () =>
    set((s) => ({
      selectionActive: !s.selectionActive,
      selectedMessageIds: s.selectionActive ? [] : s.selectedMessageIds,
    })),
  toggleMessageSelected: (id) =>
    set((s) => ({
      selectedMessageIds: s.selectedMessageIds.includes(id)
        ? s.selectedMessageIds.filter((x) => x !== id)
        : [...s.selectedMessageIds, id],
    })),
  clearSelection: () => set({ selectionActive: false, selectedMessageIds: [] }),
  selectAll: (ids) => set({ selectionActive: true, selectedMessageIds: ids }),
  openLabelPicker: (ids) => set({ labelPickerOpen: true, labelPickerTargetIds: ids }),
  closeLabelPicker: () => set({ labelPickerOpen: false, labelPickerTargetIds: [] }),
  openSnoozePicker: (ids) => set({ snoozePickerOpen: true, snoozePickerTargetIds: ids }),
  closeSnoozePicker: () => set({ snoozePickerOpen: false, snoozePickerTargetIds: [] }),
}));
