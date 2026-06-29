import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useUiStore, SEND_WATCHDOG_MS } from "./store";
import { DEFAULT_SNOOZE_CONFIG } from "../shared/snooze/snooze";
import { DEFAULT_GENERAL } from "../shared/general/general";

beforeEach(() => {
  useUiStore.setState({
    selectedAccountId: null,
    selectedFolderId: null,
    selectedMessageId: null,
    selectedThreadId: null,
    selectedSmartFolder: null,
    theme: "auto",
    accent: "#4f46e5",
    density: "comfortable",
    showPreview: true,
    showAvatars: true,
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
  });
});

describe("selectedSmartFolder mutual exclusion", () => {
  it("setSelectedSmartFolder clears account, folder, and thread selection", () => {
    useUiStore.setState({
      selectedAccountId: 1,
      selectedFolderId: 10,
      selectedThreadId: 5,
    });

    useUiStore.getState().setSelectedSmartFolder("all_inboxes");

    const s = useUiStore.getState();
    expect(s.selectedSmartFolder).toBe("all_inboxes");
    expect(s.selectedAccountId).toBeNull();
    expect(s.selectedFolderId).toBeNull();
    expect(s.selectedThreadId).toBeNull();
  });

  it("setSelectedSmartFolder(null) clears smart folder", () => {
    useUiStore.setState({ selectedSmartFolder: "unread" });
    useUiStore.getState().setSelectedSmartFolder(null);
    expect(useUiStore.getState().selectedSmartFolder).toBeNull();
  });

  it("setSelectedSmartFolder clears a stale selected message", () => {
    useUiStore.setState({ selectedMessageId: 42 });
    useUiStore.getState().setSelectedSmartFolder("unread");
    expect(useUiStore.getState().selectedMessageId).toBeNull();
  });

  it("setSelectedFolderId clears a stale selected message", () => {
    useUiStore.setState({ selectedMessageId: 42 });
    useUiStore.getState().setSelectedFolderId(7);
    expect(useUiStore.getState().selectedMessageId).toBeNull();
  });

  it("setSelectedAccountId clears a stale selected message", () => {
    useUiStore.setState({ selectedMessageId: 42 });
    useUiStore.getState().setSelectedAccountId(2);
    expect(useUiStore.getState().selectedMessageId).toBeNull();
  });

  it("setSelectedAccountId clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "flagged" });
    useUiStore.getState().setSelectedAccountId(2);
    const s = useUiStore.getState();
    expect(s.selectedAccountId).toBe(2);
    expect(s.selectedSmartFolder).toBeNull();
  });

  it("setSelectedFolderId clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "unread" });
    useUiStore.getState().setSelectedFolderId(7);
    const s = useUiStore.getState();
    expect(s.selectedFolderId).toBe(7);
    expect(s.selectedSmartFolder).toBeNull();
  });

  it("setSelectedAccountId(null) clears selectedSmartFolder", () => {
    useUiStore.setState({ selectedSmartFolder: "all_inboxes" });
    useUiStore.getState().setSelectedAccountId(null);
    expect(useUiStore.getState().selectedSmartFolder).toBeNull();
  });
});

describe("appearance state", () => {
  it("setters update individual appearance fields", () => {
    useUiStore.getState().setTheme("dark");
    useUiStore.getState().setAccent("#10b981");
    useUiStore.getState().setDensity("dense");
    useUiStore.getState().setShowPreview(false);
    useUiStore.getState().setShowAvatars(false);
    const s = useUiStore.getState();
    expect(s.theme).toBe("dark");
    expect(s.accent).toBe("#10b981");
    expect(s.density).toBe("dense");
    expect(s.showPreview).toBe(false);
    expect(s.showAvatars).toBe(false);
  });

  it("hydrateAppearance applies a partial without touching others", () => {
    useUiStore.getState().hydrateAppearance({ theme: "light", density: "compact" });
    const s = useUiStore.getState();
    expect(s.theme).toBe("light");
    expect(s.density).toBe("compact");
    expect(s.accent).toBe("#4f46e5");
  });
});

describe("shortcuts store slice", () => {
  it("setListContext stores ordered ids and mode", () => {
    useUiStore.getState().setListContext([3, 1, 2], "message");
    const s = useUiStore.getState();
    expect(s.visibleMessageIds).toEqual([3, 1, 2]);
    expect(s.selectMode).toBe("message");
  });

  it("palette toggles and closes", () => {
    useUiStore.getState().togglePalette();
    expect(useUiStore.getState().paletteOpen).toBe(true);
    useUiStore.getState().togglePalette();
    expect(useUiStore.getState().paletteOpen).toBe(false);
    useUiStore.setState({ paletteOpen: true });
    useUiStore.getState().closePalette();
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it("cheat sheet toggles and closes", () => {
    useUiStore.getState().toggleCheatSheet();
    expect(useUiStore.getState().cheatSheetOpen).toBe(true);
    useUiStore.getState().closeCheatSheet();
    expect(useUiStore.getState().cheatSheetOpen).toBe(false);
  });

  it("override set / reset and profile change", () => {
    useUiStore.getState().setShortcutProfile("vim");
    useUiStore.getState().setShortcutOverride("compose", "n");
    expect(useUiStore.getState().shortcutProfile).toBe("vim");
    expect(useUiStore.getState().shortcutOverrides.compose).toBe("n");
    useUiStore.getState().resetShortcut("compose");
    expect("compose" in useUiStore.getState().shortcutOverrides).toBe(false);
  });

  it("hydrateShortcuts merges profile and overrides", () => {
    useUiStore.getState().hydrateShortcuts({ profile: "vim", overrides: { reply: null } });
    const s = useUiStore.getState();
    expect(s.shortcutProfile).toBe("vim");
    expect(s.shortcutOverrides.reply).toBeNull();
  });
});

describe("search store slice", () => {
  beforeEach(() => {
    useUiStore.setState({
      searchQuery: "",
      searchActive: false,
      selectedFolderId: null,
      selectedSmartFolder: null,
    });
  });

  it("setSearchQuery activates search for non-empty input", () => {
    useUiStore.getState().setSearchQuery("hello");
    expect(useUiStore.getState().searchQuery).toBe("hello");
    expect(useUiStore.getState().searchActive).toBe(true);
  });

  it("setSearchQuery with blank input deactivates search", () => {
    useUiStore.getState().setSearchQuery("   ");
    expect(useUiStore.getState().searchActive).toBe(false);
  });

  it("clearSearch resets query and active flag", () => {
    useUiStore.getState().setSearchQuery("hello");
    useUiStore.getState().clearSearch();
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().searchActive).toBe(false);
  });

  it("selecting a folder clears active search", () => {
    useUiStore.getState().setSearchQuery("hello");
    useUiStore.getState().setSelectedFolderId(5);
    expect(useUiStore.getState().searchActive).toBe(false);
    expect(useUiStore.getState().searchQuery).toBe("");
  });

  it("setSelectedAccountId clears active search", () => {
    useUiStore.getState().setSearchQuery("hello");
    useUiStore.getState().setSelectedAccountId(3);
    expect(useUiStore.getState().searchActive).toBe(false);
    expect(useUiStore.getState().searchQuery).toBe("");
  });

  it("setSelectedSmartFolder clears active search", () => {
    useUiStore.getState().setSearchQuery("hello");
    useUiStore.getState().setSelectedSmartFolder("all_inboxes");
    expect(useUiStore.getState().searchActive).toBe(false);
    expect(useUiStore.getState().searchQuery).toBe("");
  });
});

describe("labels store slice", () => {
  beforeEach(() => {
    useUiStore.setState({
      selectedAccountId: null,
      selectedFolderId: null,
      selectedSmartFolder: null,
      selectedThreadId: null,
      selectedLabelId: null,
      searchQuery: "",
      searchActive: false,
      labelPickerOpen: false,
      labelPickerTargetIds: [],
    });
  });

  it("setSelectedLabelId clears other views and selection", () => {
    useUiStore.setState({ selectedSmartFolder: "unread", selectedRowIds: [1, 2], selectionAnchorId: 1 });
    useUiStore.getState().setSelectedLabelId(7);
    const s = useUiStore.getState();
    expect(s.selectedLabelId).toBe(7);
    expect(s.selectedSmartFolder).toBeNull();
    expect(s.selectedRowIds.length).toBe(0);
    expect(s.selectionAnchorId).toBeNull();
  });

  it("setSelectedLabelId clears a stale selected message", () => {
    useUiStore.setState({ selectedMessageId: 42 });
    useUiStore.getState().setSelectedLabelId(7);
    expect(useUiStore.getState().selectedMessageId).toBeNull();
  });

  it("selecting another view clears selectedLabelId", () => {
    useUiStore.getState().setSelectedLabelId(7);
    useUiStore.getState().setSelectedSmartFolder("flagged");
    expect(useUiStore.getState().selectedLabelId).toBeNull();
  });

  it("openLabelPicker stores target ids", () => {
    useUiStore.getState().openLabelPicker([3, 4]);
    expect(useUiStore.getState().labelPickerOpen).toBe(true);
    expect(useUiStore.getState().labelPickerTargetIds).toEqual([3, 4]);
    useUiStore.getState().closeLabelPicker();
    expect(useUiStore.getState().labelPickerOpen).toBe(false);
    expect(useUiStore.getState().labelPickerTargetIds).toEqual([]);
  });
});

describe("snooze picker slice", () => {
  beforeEach(() => {
    useUiStore.getState().closeSnoozePicker();
  });

  it("opens with target ids and closes clearing them", () => {
    useUiStore.getState().openSnoozePicker([3, 7]);
    expect(useUiStore.getState().snoozePickerOpen).toBe(true);
    expect(useUiStore.getState().snoozePickerTargetIds).toEqual([3, 7]);

    useUiStore.getState().closeSnoozePicker();
    expect(useUiStore.getState().snoozePickerOpen).toBe(false);
    expect(useUiStore.getState().snoozePickerTargetIds).toEqual([]);
  });
});

describe("hydrateSnooze", () => {
  beforeEach(() => {
    useUiStore.setState({
      snoozeMorningHour: DEFAULT_SNOOZE_CONFIG.morningHour,
      snoozeLaterTodayHours: DEFAULT_SNOOZE_CONFIG.laterTodayHours,
      snoozeWeekendDay: DEFAULT_SNOOZE_CONFIG.weekendDay,
      snoozeWeekStartDay: DEFAULT_SNOOZE_CONFIG.weekStartDay,
    });
  });

  it("maps SnoozeConfig keys onto the prefixed store fields", () => {
    useUiStore.getState().hydrateSnooze({ morningHour: 7, weekStartDay: 2 });
    const s = useUiStore.getState();
    expect(s.snoozeMorningHour).toBe(7);
    expect(s.snoozeWeekStartDay).toBe(2);
    expect(s.snoozeLaterTodayHours).toBe(DEFAULT_SNOOZE_CONFIG.laterTodayHours);
    expect(s.snoozeWeekendDay).toBe(DEFAULT_SNOOZE_CONFIG.weekendDay);
  });

  it("leaves all fields unchanged for an empty partial", () => {
    useUiStore.getState().hydrateSnooze({});
    const s = useUiStore.getState();
    expect(s.snoozeMorningHour).toBe(DEFAULT_SNOOZE_CONFIG.morningHour);
    expect(s.snoozeWeekStartDay).toBe(DEFAULT_SNOOZE_CONFIG.weekStartDay);
  });
});

describe("general mark-as-read slice", () => {
  beforeEach(() => {
    useUiStore.setState({
      markReadMode: DEFAULT_GENERAL.markReadMode,
      markReadDelaySeconds: DEFAULT_GENERAL.markReadDelaySeconds,
      generalHydrated: false,
    });
  });

  it("setters update the mark-as-read fields", () => {
    useUiStore.getState().setMarkReadMode("delay");
    useUiStore.getState().setMarkReadDelaySeconds(7);
    const s = useUiStore.getState();
    expect(s.markReadMode).toBe("delay");
    expect(s.markReadDelaySeconds).toBe(7);
  });

  it("hydrateGeneral maps GeneralFields keys onto the store and flips generalHydrated", () => {
    useUiStore.getState().hydrateGeneral({ markReadMode: "never", markReadDelaySeconds: 10 });
    const s = useUiStore.getState();
    expect(s.markReadMode).toBe("never");
    expect(s.markReadDelaySeconds).toBe(10);
    expect(s.generalHydrated).toBe(true);
  });

  it("bumpMarkUnreadEpoch increments the epoch", () => {
    useUiStore.setState({ markUnreadEpoch: 0 });
    useUiStore.getState().bumpMarkUnreadEpoch();
    expect(useUiStore.getState().markUnreadEpoch).toBe(1);
  });
});

describe("general list filter and sort slice", () => {
  it("sets and clears list filters without touching sort direction", () => {
    const s = useUiStore.getState();
    s.setListSortDir("asc");
    s.setListFilterSender("alice");
    s.setListFilterSubject("invoice");
    s.setListFilterAttachmentsOnly(true);
    let st = useUiStore.getState();
    expect(st.listSortDir).toBe("asc");
    expect(st.listFilterSender).toBe("alice");
    expect(st.listFilterSubject).toBe("invoice");
    expect(st.listFilterAttachmentsOnly).toBe(true);

    st.clearListFilters();
    st = useUiStore.getState();
    expect(st.listFilterSender).toBe("");
    expect(st.listFilterSubject).toBe("");
    expect(st.listFilterAttachmentsOnly).toBe(false);
    expect(st.listSortDir).toBe("asc");
  });

  it("hydrateGeneral applies listSortDir", () => {
    useUiStore.getState().hydrateGeneral({ listSortDir: "asc" });
    expect(useUiStore.getState().listSortDir).toBe("asc");
  });
});

describe("smart folder visibility", () => {
  it("setSmartFoldersEnabled toggles the master flag", () => {
    useUiStore.getState().setSmartFoldersEnabled(false);
    expect(useUiStore.getState().smartFoldersEnabled).toBe(false);
    useUiStore.getState().setSmartFoldersEnabled(true);
    expect(useUiStore.getState().smartFoldersEnabled).toBe(true);
  });

  it("setSmartFolderVisible updates one kind immutably, leaving the rest", () => {
    useUiStore.setState({
      smartFolderVisibility: { all_inboxes: true, unread: true, flagged: true, snoozed: true },
    });
    const before = useUiStore.getState().smartFolderVisibility;
    useUiStore.getState().setSmartFolderVisible("flagged", false);
    const after = useUiStore.getState().smartFolderVisibility;
    expect(after).toEqual({ all_inboxes: true, unread: true, flagged: false, snoozed: true });
    expect(after).not.toBe(before);
  });
});

describe("sending counter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    useUiStore.setState({ sendingCount: 0, lastSentAt: null, sendWatchdogs: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("increments on each started send", () => {
    useUiStore.getState().markSendStarted();
    useUiStore.getState().markSendStarted();
    expect(useUiStore.getState().sendingCount).toBe(2);
  });

  it("decrements and records lastSentAt on success", () => {
    useUiStore.getState().markSendStarted();
    useUiStore.getState().markSendSucceeded();
    expect(useUiStore.getState().sendingCount).toBe(0);
    expect(useUiStore.getState().lastSentAt).toBe(1_000_000);
  });

  it("decrements without lastSentAt on failure", () => {
    useUiStore.getState().markSendStarted();
    useUiStore.getState().markSendFailed();
    expect(useUiStore.getState().sendingCount).toBe(0);
    expect(useUiStore.getState().lastSentAt).toBeNull();
  });

  it("never goes below zero on an extra confirmation", () => {
    useUiStore.getState().markSendSucceeded();
    expect(useUiStore.getState().sendingCount).toBe(0);
  });

  it("watchdog clears a stuck send after SEND_WATCHDOG_MS", () => {
    useUiStore.getState().markSendStarted();
    expect(useUiStore.getState().sendingCount).toBe(1);
    vi.advanceTimersByTime(SEND_WATCHDOG_MS);
    expect(useUiStore.getState().sendingCount).toBe(0);
  });

  it("a real confirmation cancels the watchdog (no double decrement)", () => {
    useUiStore.getState().markSendStarted();
    useUiStore.getState().markSendSucceeded();
    expect(useUiStore.getState().sendingCount).toBe(0);
    vi.advanceTimersByTime(SEND_WATCHDOG_MS);
    expect(useUiStore.getState().sendingCount).toBe(0);
  });
});
