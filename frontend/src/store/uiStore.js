import { create } from 'zustand';

export const useUiStore = create((set) => ({
  listFilter: 'all',
  setListFilter: (filter) => set({ listFilter: filter }),
}));
