import { create } from 'zustand';
import * as vmApi from '../api/vms.js';
import { createSSE } from '../api/sse.js';
import { sendAndAwaitChange, sendAndAwaitTopic, subscribeChanges, subscribeTopic } from '../api/events.js';
import { withWorkloadAction, anyActionInFlight, pruneWorkloadActions } from './workloadActions.js';
import { awaitJob } from './backgroundJobsStore.js';
import { JOB_KIND } from '../api/jobProgress.js';

/**
 * The list feed refreshes on every libvirt domain event, so it carries the
 * selected VM's state and restart-required flag ahead of any detail re-fetch
 * (the flag is dropped by the list refresh that observes the new QEMU).
 * Returns the updated config, or null when nothing changed.
 */
function mergeListFields(vmConfig, listItem) {
  const pendingRestart = listItem.pendingRestart ?? null;
  const unchanged = listItem.state === vmConfig.state
    && (pendingRestart?.since ?? null) === (vmConfig.pendingRestart?.since ?? null);
  if (unchanged) return null;
  return { ...vmConfig, state: listItem.state, pendingRestart };
}

/** A `vms` frame matcher: the list shows VM `name` in `state` (an error frame never matches). */
function listShowsState(name, state) {
  return (list) => Array.isArray(list) && list.some((vm) => vm.name === name && vm.state === state);
}

export const useVmStore = create((set, get) => {
  // Single subscriber per feed: one `vms` topic subscription (shared /api/events
  // stream) and one per-VM stats SSE are active at a time. Close functions are
  // stored here so stopVMListSSE/stopStatsSSE/deselectVM can clean up.
  let listCloseFn = null;
  let changesCloseFn = null;
  let statsCloseFn = null;
  // Bumped on every selection change (select, deselect, rename-follow). A getVM
  // response is applied only if no selection change happened while it was in
  // flight — otherwise a slow response for the previous VM would overwrite the
  // current one and the header actions would target the wrong VM.
  let selectionSeq = 0;
  // Every getVM of the selection is numbered; a response is applied only when it is
  // newer than the last one applied, so two quick re-reads can't land out of order.
  let configReadsSent = 0;
  let configReadsApplied = 0;

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
    selectionSeq += 1;
    set({ selectedVM: match.name, renamedSelection: { from: selectedVM, to: match.name } });
    startStatsSSE(match.name);
    queueMicrotask(() => {
      get().refreshSelectedVM().catch(() => {
        /* refreshSelectedVM records the failure in `error`, which the detail view shows */
      });
    });
  }

  return {
    vms: [],
    selectedVM: null,
    vmConfig: null,
    vmStats: null,
    configLoading: false,
    /** Per-VM action state (workloadActions.js); `error` is for list and select failures only. */
    actions: {},
    error: null,
    /** The list has loaded once; `listError` is the list stream's last error (the list shown is the last good one). */
    listLoaded: false,
    listError: null,
    /** `{ from, to }` after the selection followed a rename seen on the list, until the route follows it. */
    renamedSelection: null,

    clearRenamedSelection: () => set({ renamedSelection: null }),

    fetchVMs: async () => {
      try {
        const vms = await vmApi.listVMs();
        migrateSelectionIfRenamed(vms);
        set((prev) => ({ vms, listLoaded: true, listError: null, actions: pruneWorkloadActions(prev.actions, new Set(vms.map((v) => v.name))) }));

        const { selectedVM, vmConfig, configLoading, actions } = get();
        // Skip auto-deselect while a select or action is in flight — the VM may
        // legitimately not be in the list yet (post-create race) or be there
        // under its prior name (post-rename race). Subsequent SSE frames will
        // deselect once configLoading and the actions clear if it is truly gone.
        if (selectedVM && !vms.find(v => v.name === selectedVM) && !configLoading && !anyActionInFlight(actions)) {
          get().deselectVM();
        } else if (selectedVM && vmConfig) {
          const vm = vms.find(v => v.name === selectedVM);
          const merged = vm && mergeListFields(vmConfig, vm);
          if (merged) set({ vmConfig: merged });
        }
      } catch (err) {
        set({ error: err.message, listError: err.detail || err.message });
      }
    },

    startVMListSSE: () => {
      if (listCloseFn) return;
      changesCloseFn = subscribeChanges(['vm'], (change) => {
        const { selectedVM } = get();
        if (!selectedVM) return;
        if (change.kind === 'all' || change.id === selectedVM) return get().refreshSelectedVM();
        return undefined;
      });
      listCloseFn = subscribeTopic(
        'vms',
        (data) => {
          if (data && !Array.isArray(data) && data.error) {
            set({ listError: data.detail || data.error });
            return;
          }
          if (!Array.isArray(data)) return;
          migrateSelectionIfRenamed(data);
          const state = get();
          // Skip auto-deselect while a select or action is in flight — the VM
          // may legitimately not be in this SSE frame yet (post-create race
          // before libvirt's DomainEvent reaches us). Without this gate, the
          // listener fires deselectVM during the gap between selectVM setting
          // selectedVM and getVM resolving, leaving selectedVM=null while
          // vmConfig still gets populated from getVM — a stuck-stale state.
          if (
            state.selectedVM &&
            !data.find((v) => v.name === state.selectedVM) &&
            !state.configLoading &&
            !anyActionInFlight(state.actions)
          ) {
            get().deselectVM();
          }
          set((prev) => {
            const next = {
              vms: data,
              listLoaded: true,
              listError: null,
              actions: pruneWorkloadActions(prev.actions, new Set(data.map((x) => x.name))),
            };
            if (prev.selectedVM && prev.vmConfig) {
              const vm = data.find((v) => v.name === prev.selectedVM);
              const merged = vm && mergeListFields(prev.vmConfig, vm);
              if (merged) next.vmConfig = merged;
            }
            return next;
          });
        },
      );
    },

    stopVMListSSE: () => {
      if (listCloseFn) {
        listCloseFn();
        listCloseFn = null;
      }
      if (changesCloseFn) {
        changesCloseFn();
        changesCloseFn = null;
      }
    },

    selectVM: async (name) => {
      const listItem = get().vms.find((v) => v.name === name);
      const seed = listItem
        ? { name: listItem.name, uuid: listItem.uuid, state: listItem.state, stateCode: listItem.stateCode, vcpus: listItem.vcpus, memoryMiB: listItem.memoryMiB, osCategory: listItem.osCategory, iconId: listItem.iconId, pendingRestart: listItem.pendingRestart }
        : null;
      const seq = ++selectionSeq;
      set({ selectedVM: name, vmConfig: seed, vmStats: null, configLoading: true, error: null });
      startStatsSSE(name);
      const read = ++configReadsSent;
      try {
        const config = await vmApi.getVM(name);
        if (seq !== selectionSeq) return;
        if (read <= configReadsApplied) {
          set({ configLoading: false });
          return;
        }
        configReadsApplied = read;
        set({ vmConfig: config, configLoading: false });
      } catch (err) {
        if (seq !== selectionSeq) return;
        // A newer read already applied, or still on its way, has the say.
        if (read !== configReadsSent || read <= configReadsApplied) {
          set({ configLoading: false });
          return;
        }
        set({ vmConfig: null, error: err.message, configLoading: false });
      }
    },

    deselectVM: () => {
      stopStatsSSE();
      selectionSeq += 1;
      // configLoading is reset here because the in-flight select's response is now dropped.
      set({ selectedVM: null, vmConfig: null, vmStats: null, configLoading: false });
    },

    clearError: () => set({ error: null }),
    clearActionError: (name) => set((s) => ({ actions: withWorkloadAction(s.actions, name, { action: null, error: null }) })),
    /** Show a command's failure in VM `name`'s action error (the detail view's banner),
     *  leaving any action in flight on it tracked. */
    reportActionError: (name, message) => set((s) => ({
      actions: withWorkloadAction(s.actions, name, { action: s.actions[name]?.action ?? null, error: message }),
    })),

    /**
     * Re-read the selected VM's config. A failure is recorded in `error` (the detail
     * view's dismissible banner; the config shown stays) unless a newer read is
     * already on its way, and rejects, so a command waiting on it (runVMCommand)
     * fails instead of resolving onto the old config.
     */
    refreshSelectedVM: async () => {
      const { selectedVM } = get();
      if (!selectedVM) return;
      const seq = selectionSeq;
      const read = ++configReadsSent;
      let config;
      try {
        config = await vmApi.getVM(selectedVM);
      } catch (err) {
        if (seq === selectionSeq && read === configReadsSent && read > configReadsApplied) {
          set({ error: `Couldn't refresh this VM: ${err.detail || err.message}` });
        }
        throw err;
      }
      if (seq !== selectionSeq || read <= configReadsApplied) return;
      configReadsApplied = read;
      set({ vmConfig: config });
    },

    /**
     * Run one action on VM `name`, tracked in `actions[name]`. Only touches the selection
     * when it is `name`. An error already shown on the VM stays until it is dismissed:
     * the action replaces it only with its own failure.
     */
    async withAction(name, actionName, fn) {
      const track = (action, error) => set((s) => ({
        actions: withWorkloadAction(s.actions, name, { action, error: error === undefined ? (s.actions[name]?.error ?? null) : error }),
      }));
      track(actionName);
      /* The new state arrives on the `vms` topic and the stats stream: no follow-up GET. */
      try {
        await fn();
        track(null);
        if (actionName === 'delete' && get().selectedVM === name) get().deselectVM();
      } catch (err) {
        track(null, err.message);
      }
    },

    startVM: async (name) => {
      await get().withAction(name, 'start', async () => awaitJob(JOB_KIND.VM_START, await vmApi.startVM(name)));
    },
    /* Suspend and resume stay busy until a `vms` frame shows the VM in its new state.
     * Stop (an ACPI shutdown) and reboot are requests the guest may ignore, so they
     * end at the ack: the list shows the VM stopping when it does. */
    stopVM: async (name) => {
      await get().withAction(name, 'stop', () => vmApi.stopVM(name));
    },
    forceStopVM: async (name) => {
      await get().withAction(name, 'force-stop', async () => awaitJob(JOB_KIND.VM_FORCE_STOP, await vmApi.forceStopVM(name)));
    },
    rebootVM: async (name) => {
      await get().withAction(name, 'reboot', () => vmApi.rebootVM(name));
    },
    suspendVM: async (name) => {
      await get().withAction(name, 'suspend', () =>
        sendAndAwaitTopic('vms', () => vmApi.suspendVM(name), listShowsState(name, 'paused')));
    },
    resumeVM: async (name) => {
      await get().withAction(name, 'resume', () =>
        sendAndAwaitTopic('vms', () => vmApi.resumeVM(name), listShowsState(name, 'running')));
    },
    deleteVM: async (name, deleteDisks) => {
      await get().withAction(name, 'delete', async () =>
        awaitJob(JOB_KIND.VM_DELETE, await vmApi.deleteVM(name, deleteDisks)));
    },
  };
});

/**
 * Send a command that changes VM `name` (its name after a rename) and resolve with
 * its ack once the client holds the new state: the `{ kind: 'vm', id: name }`
 * frame has arrived and every re-read the open detail view started for it (the
 * store's config, the USB and cloud-init sections) has landed. The control that
 * sent it stays busy until then. A command error, or a failed re-read, rejects.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
export function runVMCommand(name, send) {
  return sendAndAwaitChange('vm', name, send);
}
