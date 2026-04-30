import { create } from 'zustand';

export const useUiStore = create((set) => ({
  listFilter: 'all',
  setListFilter: (filter) => set({ listFilter: filter }),
  organizeMode: false,
  setOrganizeMode: (on) => set({ organizeMode: !!on }),
  toggleOrganizeMode: () => set((s) => ({ organizeMode: !s.organizeMode })),
}));
