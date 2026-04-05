import { create } from 'zustand';
import * as containerApi from '../api/containers.js';
import { createSSE } from '../api/sse.js';

export const useContainerStore = create((set, get) => {
  let listCloseFn = null;
  let statsCloseFn = null;

  function startStatsSSE(name, intervalMs = 3000) {
    stopStatsSSE();
    const q = Math.max(2000, Math.min(60000, intervalMs));
    statsCloseFn = createSSE(
      `/api/containers/${encodeURIComponent(name)}/stats?intervalMs=${q}`,
      (data) => {
        set((state) => {
          const next = { containerStats: data };
          if (state.containerConfig && state.selectedContainer === name
            && data?.state != null && data.state !== state.containerConfig.state) {
            next.containerConfig = { ...state.containerConfig, state: data.state };
          }
          return next;
        });
      },
      () => {
        /* Stream error; createSSE will reconnect — clear stale stats */
        set({ containerStats: null });
      },
    );
  }

  function stopStatsSSE() {
    if (statsCloseFn) {
      statsCloseFn();
      statsCloseFn = null;
    }
    set({ containerStats: null });
  }

  return {
    containers: [],
    selectedContainer: null,
    containerConfig: null,
    containerStats: null,
    loading: false,
    actionLoading: null,
    error: null,

    fetchContainers: async () => {
      try {
        const containers = await containerApi.listContainers();
        set({ containers });

        const { selectedContainer, containerConfig } = get();
        if (selectedContainer && !containers.find((c) => c.name === selectedContainer)) {
          get().deselectContainer();
        } else if (selectedContainer && containerConfig) {
          const ct = containers.find((c) => c.name === selectedContainer);
          if (ct && ct.state !== containerConfig.state) {
            set({ containerConfig: { ...containerConfig, state: ct.state } });
          }
        }
      } catch (err) {
        set({ error: err.message });
      }
    },

    startContainerListSSE: (intervalMs = 5000) => {
      if (listCloseFn) return;
      get().fetchContainers();
      const url = `/api/containers/stream?intervalMs=${Math.max(2000, Math.min(60000, intervalMs))}`;
      listCloseFn = createSSE(
        url,
        (data) => {
          if (!Array.isArray(data)) return;
          const state = get();
          // Only deselect when the stream lists other workloads but not this one.
          // Empty [] can be transient (race, parse glitch); deselecting clears the panel and looks like a blank page.
          if (
            state.selectedContainer
            && data.length > 0
            && !data.find((c) => c.name === state.selectedContainer)
          ) {
            get().deselectContainer();
          }
          set((prev) => {
            const next = { containers: data };
            if (prev.selectedContainer && prev.containerConfig) {
              const ct = data.find((c) => c.name === prev.selectedContainer);
              if (ct && ct.state !== prev.containerConfig.state) {
                next.containerConfig = { ...prev.containerConfig, state: ct.state };
              }
            }
            return next;
          });
        },
        () => {
          /* createSSE reconnects on failure; no extra UI for list stream */
        },
      );
    },

    stopContainerListSSE: () => {
      if (listCloseFn) {
        listCloseFn();
        listCloseFn = null;
      }
    },

    selectContainer: async (name) => {
      set({ selectedContainer: name, containerConfig: null, containerStats: null, loading: true });
      startStatsSSE(name);
      try {
        const config = await containerApi.getContainer(name);
        set({ containerConfig: config, loading: false });
      } catch (err) {
        set({ error: err.message, loading: false });
      }
    },

    deselectContainer: () => {
      stopStatsSSE();
      set({ selectedContainer: null, containerConfig: null, containerStats: null });
    },

    clearError: () => set({ error: null }),

    refreshSelectedContainer: async () => {
      const { selectedContainer } = get();
      if (!selectedContainer) return;
      try {
        const config = await containerApi.getContainer(selectedContainer);
        set({ containerConfig: config });
      } catch { /* Container may have been deleted */ }
    },

    async withAction(actionName, fn) {
      set({ actionLoading: actionName, error: null });
      try {
        await fn();
        set({ actionLoading: null });
        await get().fetchContainers();
        if (actionName === 'delete') {
          get().deselectContainer();
        } else {
          await get().refreshSelectedContainer();
        }
      } catch (err) {
        set({ actionLoading: null, error: err.message });
      }
    },

    startContainer: async (name) => {
      await get().withAction('start', () => containerApi.startContainerApi(name));
    },
    stopContainer: async (name) => {
      await get().withAction('stop', () => containerApi.stopContainerApi(name));
    },
    restartContainer: async (name) => {
      await get().withAction('restart', () => containerApi.restartContainerApi(name));
    },
    killContainer: async (name) => {
      await get().withAction('kill', () => containerApi.killContainerApi(name));
    },
    deleteContainer: async (name, deleteFiles) => {
      await get().withAction('delete', () => containerApi.deleteContainerApi(name, deleteFiles));
    },
  };
});
