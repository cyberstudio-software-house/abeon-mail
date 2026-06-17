import { create } from "zustand";

export type Density = "comfortable" | "cozy" | "compact" | "dense";

type ComposerState = {
  open: boolean;
  draftId: number | null;
};

type UiState = {
  selectedAccountId: number | null;
  selectedFolderId: number | null;
  selectedMessageId: number | null;
  selectedThreadId: number | null;
  density: Density;
  composer: ComposerState;
  setSelectedAccountId: (id: number | null) => void;
  setSelectedFolderId: (id: number | null) => void;
  setSelectedMessageId: (id: number | null) => void;
  setSelectedThreadId: (id: number | null) => void;
  setDensity: (density: Density) => void;
  openComposer: (draftId: number | null) => void;
  closeComposer: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedAccountId: null,
  selectedFolderId: null,
  selectedMessageId: null,
  selectedThreadId: null,
  density: "comfortable",
  composer: { open: false, draftId: null },
  setSelectedAccountId: (id) => set({ selectedAccountId: id }),
  setSelectedFolderId: (id) => set({ selectedFolderId: id }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedThreadId: (id) => set({ selectedThreadId: id }),
  setDensity: (density) => set({ density }),
  openComposer: (draftId) => set({ composer: { open: true, draftId } }),
  closeComposer: () => set({ composer: { open: false, draftId: null } }),
}));
