import { create } from 'zustand';
import * as containerApi from '../api/containers.js';
import { createSSE } from '../api/sse.js';
import { subscribeTopic } from '../api/events.js';
import { subscribeJobProgress, JOB_KIND } from '../api/jobProgress.js';

/** Same scheduled restart (or both none)? Compared by value — list pushes carry fresh objects. */
function sameScheduledRestart(a, b) {
  if (!a || !b) return !a && !b;
  return a.attempt === b.attempt && a.at === b.at;
}

/**
 * The list topic is the live source for a workload's run state; carry its
 * `state` and `scheduledRestart` into the selected container's config.
 * Returns the updated config, or null when nothing changed.
 */
function configSyncedFromListItem(config, item) {
  if (!item) return null;
  const scheduledRestart = item.scheduledRestart ?? null;
  if (item.state === config.state && sameScheduledRestart(scheduledRestart, config.scheduledRestart)) return null;
  return { ...config, state: item.state, scheduledRestart };
}

export const useContainerStore = create((set, get) => {
  let listCloseFn = null;
  let statsCloseFn = null;
  // Bumped on every selection change; a getContainer response is applied only if
  // the selection did not change while it was in flight (see vmStore).
  let selectionSeq = 0;

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

  let imageUpdateJobClose = null;

  return {
    containers: [],
    selectedContainer: null,
    containerConfig: null,
    containerStats: null,
    loading: false,
    actionLoading: null,
    error: null,

    imageUpdateCheck: {
      running: false,
      ref: null,
      lastCheckedAt: null,
      imagesChecked: 0,
      imagesUpdated: 0,
      flaggedContainers: 0,
      lastError: null,
      currentRef: null,
      progress: null,
    },

    fetchContainers: async () => {
      try {
        const containers = await containerApi.listContainers();
        set({ containers });

        const { selectedContainer, containerConfig, loading, actionLoading } = get();
        // Skip auto-deselect while a select or action is in flight — the
        // container may legitimately not be in the list yet (post-create
        // race). See vmStore for the symmetric fix and full reasoning.
        if (
          selectedContainer
          && !containers.find((c) => c.name === selectedContainer)
          && !loading
          && !actionLoading
        ) {
          get().deselectContainer();
        } else if (selectedContainer && containerConfig) {
          const synced = configSyncedFromListItem(
            containerConfig,
            containers.find((c) => c.name === selectedContainer),
          );
          if (synced) set({ containerConfig: synced });
        }
      } catch (err) {
        set({ error: err.message });
      }
    },

    startContainerListSSE: () => {
      if (listCloseFn) return;
      get().fetchContainers();
      listCloseFn = subscribeTopic(
        'containers',
        (data) => {
          if (!Array.isArray(data)) return;
          const state = get();
          // Only deselect when the stream lists other workloads but not this one.
          // Empty [] can be transient (race, parse glitch); deselecting clears the panel and looks like a blank page.
          if (
            state.selectedContainer
            && data.length > 0
            && !data.find((c) => c.name === state.selectedContainer)
            && !state.loading
            && !state.actionLoading
          ) {
            get().deselectContainer();
          }
          set((prev) => {
            const next = { containers: data };
            if (prev.selectedContainer && prev.containerConfig) {
              const synced = configSyncedFromListItem(
                prev.containerConfig,
                data.find((c) => c.name === prev.selectedContainer),
              );
              if (synced) next.containerConfig = synced;
            }
            return next;
          });
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
      /* Seed from the list item (mirrors vmStore.selectVM) so the panel header
       * paints immediately from data already in memory — a stalled config fetch
       * (phone waking on a dead socket) must not leave the whole panel on a
       * spinner. The body still waits on `loading` for the full config. */
      const listItem = get().containers.find((c) => c.name === name);
      const seed = listItem
        ? {
            name: listItem.name,
            type: 'container',
            image: listItem.image,
            state: listItem.state,
            iconId: listItem.iconId,
            autoBackup: listItem.autoBackup,
            updateAvailable: listItem.updateAvailable,
            scheduledRestart: listItem.scheduledRestart ?? null,
          }
        : null;
      const seq = ++selectionSeq;
      set({ selectedContainer: name, containerConfig: seed, containerStats: null, loading: true, error: null });
      startStatsSSE(name);
      try {
        const config = await containerApi.getContainer(name);
        if (seq !== selectionSeq) return;
        set({ containerConfig: config, loading: false });
      } catch (err) {
        if (seq !== selectionSeq) return;
        set({ error: err.message, loading: false });
      }
    },

    deselectContainer: () => {
      stopStatsSSE();
      selectionSeq += 1;
      // loading is reset here because the in-flight select's response is now dropped.
      set({ selectedContainer: null, containerConfig: null, containerStats: null, loading: false });
    },

    clearError: () => set({ error: null }),

    refreshSelectedContainer: async () => {
      const { selectedContainer } = get();
      if (!selectedContainer) return;
      const seq = selectionSeq;
      try {
        const config = await containerApi.getContainer(selectedContainer);
        if (seq !== selectionSeq) return;
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

    refreshImageUpdateStatus: async () => {
      try {
        const status = await containerApi.getImageUpdateStatus();
        set((prev) => ({
          imageUpdateCheck: {
            ...prev.imageUpdateCheck,
            lastCheckedAt: status.lastCheckedAt,
            imagesChecked: status.imagesChecked || 0,
            imagesUpdated: status.imagesUpdated || 0,
          },
        }));
      } catch { /* cached status is best-effort */ }
    },

    startImageUpdateCheck: async (ref = null) => {
      const state = get();
      if (state.imageUpdateCheck.running) return;

      set((prev) => ({
        imageUpdateCheck: {
          ...prev.imageUpdateCheck,
          running: true,
          ref,
          lastError: null,
          currentRef: null,
          progress: null,
        },
      }));

      let job;
      try {
        job = await containerApi.checkContainerImageUpdates(ref);
      } catch (err) {
        set((prev) => ({
          imageUpdateCheck: { ...prev.imageUpdateCheck, running: false, lastError: err.message },
        }));
        return;
      }

      if (imageUpdateJobClose) {
        imageUpdateJobClose();
        imageUpdateJobClose = null;
      }

      imageUpdateJobClose = subscribeJobProgress(
        JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK,
        job.jobId,
        (ev) => {
          if (ev.step === 'checking') {
            set((prev) => ({
              imageUpdateCheck: {
                ...prev.imageUpdateCheck,
                currentRef: ev.ref,
                progress: { index: ev.index, total: ev.total },
              },
            }));
          } else if (ev.step === 'done') {
            set((prev) => ({
              imageUpdateCheck: {
                ...prev.imageUpdateCheck,
                running: false,
                ref: null,
                currentRef: null,
                progress: null,
                lastCheckedAt: ev.lastCheckedAt || new Date().toISOString(),
                imagesChecked: ev.checked || 0,
                imagesUpdated: ev.updated || 0,
                flaggedContainers: ev.flaggedContainers || 0,
              },
            }));
            if (imageUpdateJobClose) {
              imageUpdateJobClose();
              imageUpdateJobClose = null;
            }
            // Backend fires notifyContainerConfigWrite after the job completes
            // → the `containers` topic pushes a fresh list automatically.
            get().refreshSelectedContainer();
          } else if (ev.step === 'error') {
            set((prev) => ({
              imageUpdateCheck: {
                ...prev.imageUpdateCheck,
                running: false,
                ref: null,
                currentRef: null,
                progress: null,
                lastError: ev.error || 'Image update check failed',
              },
            }));
            if (imageUpdateJobClose) {
              imageUpdateJobClose();
              imageUpdateJobClose = null;
            }
          }
        },
      );
    },
  };
});
