import { create } from 'zustand';

export const useUiStore = create((set) => ({
  centerView: 'default',
  setCenterView: (view) => set({ centerView: view }),

  hostTab: 'overview',
  setHostTab: (tab) => set({ hostTab: tab }),

  listFilter: 'all',
  setListFilter: (filter) => set({ listFilter: filter }),
}));
