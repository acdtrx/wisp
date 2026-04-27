import { create } from 'zustand';
import * as vmApi from '../api/vms.js';
import { createSSE } from '../api/sse.js';

export const useVmStore = create((set, get) => {
  // Single subscriber per stream: only one VM list and one stats SSE are active at a time.
  // Close functions are stored here so stopVMListSSE/stopStatsSSE/deselectVM can clean up.
  let listCloseFn = null;
  let statsCloseFn = null;

  function startStatsSSE(name) {
    stopStatsSSE();
    statsCloseFn = createSSE(
      `/api/vms/${encodeURIComponent(name)}/stats`,
      (data) => {
        set((state) => {
          const next = { vmStats: data };
          if (state.vmConfig && state.selectedVM === name && data?.state != null) {
            next.vmConfig = { ...state.vmConfig, state: data.state };
          }
          return next;
        });
      },
      () => set({ vmStats: null }),
    );
  }

  function stopStatsSSE() {
    if (statsCloseFn) {
      statsCloseFn();
      statsCloseFn = null;
    }
    set({ vmStats: null });
  }

  /** If the selected name vanished from the list but the same UUID appears under a new name (rename), follow it. */
  function migrateSelectionIfRenamed(vmsList) {
    if (!Array.isArray(vmsList) || vmsList.length === 0) return;
    const { selectedVM, vmConfig } = get();
    if (!selectedVM) return;
    if (vmsList.some((v) => v.name === selectedVM)) return;
    const uuid = vmConfig?.uuid;
    if (!uuid) return;
    const match = vmsList.find((v) => v.uuid === uuid);
    if (!match || match.name === selectedVM) return;
    stopStatsSSE();
    set({ selectedVM: match.name });
    startStatsSSE(match.name);
    queueMicrotask(() => {
      get().refreshSelectedVM(match.name);
    });
  }

  return {
    vms: [],
    selectedVM: null,
    vmConfig: null,
    vmStats: null,
    configLoading: false,
    actionLoading: null,
    error: null,

    fetchVMs: async () => {
      try {
        const vms = await vmApi.listVMs();
        migrateSelectionIfRenamed(vms);
        set({ vms });

        const { selectedVM, vmConfig } = get();
        if (selectedVM && !vms.find(v => v.name === selectedVM)) {
          get().deselectVM();
        } else if (selectedVM && vmConfig) {
          const vm = vms.find(v => v.name === selectedVM);
          if (vm && vm.state !== vmConfig.state) {
            set({ vmConfig: { ...vmConfig, state: vm.state } });
          }
        }
      } catch (err) {
        set({ error: err.message });
      }
    },

    startVMListSSE: () => {
      if (listCloseFn) return;
      listCloseFn = createSSE(
        '/api/vms/stream',
        (data) => {
          if (!Array.isArray(data)) return;
          migrateSelectionIfRenamed(data);
          const state = get();
          if (state.selectedVM && !data.find((v) => v.name === state.selectedVM)) {
            get().deselectVM();
          }
          set((prev) => {
            const next = { vms: data };
            if (prev.selectedVM && prev.vmConfig) {
              const vm = data.find((v) => v.name === prev.selectedVM);
              if (vm && vm.state !== prev.vmConfig.state) {
                next.vmConfig = { ...prev.vmConfig, state: vm.state };
              }
            }
            return next;
          });
        },
        () => {},
      );
    },

    stopVMListSSE: () => {
      if (listCloseFn) {
        listCloseFn();
        listCloseFn = null;
      }
    },

    selectVM: async (name) => {
      const listItem = get().vms.find((v) => v.name === name);
      const seed = listItem
        ? { name: listItem.name, uuid: listItem.uuid, state: listItem.state, stateCode: listItem.stateCode, vcpus: listItem.vcpus, memoryMiB: listItem.memoryMiB, osCategory: listItem.osCategory, iconId: listItem.iconId }
        : null;
      set({ selectedVM: name, vmConfig: seed, vmStats: null, configLoading: true });
      startStatsSSE(name);
      try {
        const config = await vmApi.getVM(name);
        set({ vmConfig: config, configLoading: false });
      } catch (err) {
        set({ error: err.message, configLoading: false });
      }
    },

    deselectVM: () => {
      stopStatsSSE();
      set({ selectedVM: null, vmConfig: null, vmStats: null });
    },

    clearError: () => set({ error: null }),

    /**
     * Reload config for the current selection. Pass `newSelectedName` after a rename so the
     * selected VM key and stats stream match libvirt before the next list SSE tick.
     */
    refreshSelectedVM: async (newSelectedName) => {
      const { selectedVM } = get();
      const trimmed =
        typeof newSelectedName === 'string'
          ? newSelectedName.trim()
          : newSelectedName != null
            ? String(newSelectedName).trim()
            : '';
      const targetName = trimmed !== '' ? trimmed : selectedVM;
      if (!targetName) return;
      if (trimmed !== '' && trimmed !== selectedVM) {
        stopStatsSSE();
        set({ selectedVM: trimmed });
        startStatsSSE(trimmed);
      }
      try {
        const config = await vmApi.getVM(targetName);
        set({ vmConfig: config });
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn('[vmStore] refreshSelectedVM: getVM failed', targetName, err);
        }
      }
    },

    async withAction(actionName, fn) {
      set({ actionLoading: actionName, error: null });
      try {
        await fn();
        set({ actionLoading: null });
        await get().fetchVMs();
        if (actionName === 'delete') {
          get().deselectVM();
        } else {
          await get().refreshSelectedVM();
        }
      } catch (err) {
        set({ actionLoading: null, error: err.message });
      }
    },

    startVM: async (name) => {
      await get().withAction('start', () => vmApi.startVM(name));
    },
    stopVM: async (name) => {
      await get().withAction('stop', () => vmApi.stopVM(name));
    },
    forceStopVM: async (name) => {
      await get().withAction('force-stop', () => vmApi.forceStopVM(name));
    },
    rebootVM: async (name) => {
      await get().withAction('reboot', () => vmApi.rebootVM(name));
    },
    suspendVM: async (name) => {
      await get().withAction('suspend', () => vmApi.suspendVM(name));
    },
    resumeVM: async (name) => {
      await get().withAction('resume', () => vmApi.resumeVM(name));
    },
    cloneVM: async (name, newName) => {
      await get().withAction('clone', () => vmApi.cloneVM(name, newName));
    },
    deleteVM: async (name, deleteDisks) => {
      await get().withAction('delete', () => vmApi.deleteVM(name, deleteDisks));
    },
  };
});
