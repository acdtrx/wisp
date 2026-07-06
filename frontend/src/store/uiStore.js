import { create } from 'zustand';

export const useUiStore = create((set) => ({
  listFilter: 'all',
  setListFilter: (filter) => set({ listFilter: filter }),
  organizeMode: false,
  setOrganizeMode: (on) => set({ organizeMode: !!on }),
  toggleOrganizeMode: () => set((s) => ({ organizeMode: !s.organizeMode })),
  /* Below lg the left panel is an off-canvas drawer; this drives it.
     Harmless on desktop where the panel is statically visible. */
  sidebarOpen: false,
  setSidebarOpen: (on) => set({ sidebarOpen: !!on }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
