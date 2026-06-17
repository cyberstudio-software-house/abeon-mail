import { create } from "zustand";

type Density = "comfortable" | "cozy" | "compact" | "dense";

type UiState = {
  selectedAccountId: number | null;
  selectedFolderId: number | null;
  selectedMessageId: number | null;
  density: Density;
  setSelectedAccountId: (id: number | null) => void;
  setSelectedFolderId: (id: number | null) => void;
  setSelectedMessageId: (id: number | null) => void;
  setDensity: (density: Density) => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedAccountId: null,
  selectedFolderId: null,
  selectedMessageId: null,
  density: "comfortable",
  setSelectedAccountId: (id) => set({ selectedAccountId: id }),
  setSelectedFolderId: (id) => set({ selectedFolderId: id }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setDensity: (density) => set({ density }),
}));
