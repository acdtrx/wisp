import { create } from 'zustand';
import * as vmApi from '../api/vms.js';
import { createSSE } from '../api/sse.js';
import { sendAndAwaitChange, sendAndAwaitTopic, subscribeChanges, subscribeTopic } from '../api/events.js';
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

/** A `vms` frame matcher: the list shows VM `name` out of `state`, the one it was in
 *  before the command — moved on to the target or past it, or gone (an error frame
 *  never matches). */
function listShowsLeft(name, state) {
  return (list) => {
    if (!Array.isArray(list)) return false;
    const vm = list.find((v) => v.name === name);
    return !vm || vm.state !== state;
  };
}

/*
 * Busy and errors are kept apart. `actions[name]` is the action in flight on VM `name`
 * ('start', 'delete', …), nothing else. `errors` holds what the detail view shows, each
 * until the user dismisses it, keyed by owner and VM: an `action`'s failure (a new
 * action's failure replaces it; a success leaves it), a failed `refresh` of the config,
 * the `select` read that left no config (the error page), and the `list` (no VM).
 */
function errorKey(owner, vm) {
  return `${owner}:${vm ?? ''}`;
}

function withError(errors, owner, vm, message) {
  return { ...errors, [errorKey(owner, vm)]: { owner, vm: vm ?? null, message } };
}

function withoutError(errors, owner, vm) {
  const key = errorKey(owner, vm);
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

/** The errors without those of VMs no longer listed (deleted). A `select` error stays:
 *  it is the error page of a VM that may never have been listed, up until the user
 *  navigates away (the next select of that name clears it). */
function withoutErrorsOfVanished(errors, names) {
  let next = null;
  for (const [key, entry] of Object.entries(errors)) {
    if (entry.vm == null || entry.owner === 'select' || names.has(entry.vm)) continue;
    next ??= { ...errors };
    delete next[key];
  }
  return next ?? errors;
}

/** The errors with VM `from`'s action and refresh errors moved to `to` (a rename: the
 *  VM still exists, so its undismissed errors stay with it). */
function withErrorsRenamed(errors, from, to) {
  let next = errors;
  for (const owner of ['action', 'refresh']) {
    const entry = errors[errorKey(owner, from)];
    if (!entry) continue;
    next = withError(withoutError(next, owner, from), owner, to, entry.message);
  }
  return next;
}

function withBusy(actions, name, action) {
  const next = { ...actions };
  if (action) next[name] = action;
  else delete next[name];
  return next;
}

const anyActionInFlight = (actions) => Object.keys(actions).length > 0;

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
  // The newest read of the current selection that failed: `{ seq, read, message }`. An
  // older read landing after it must not hide it (see applyConfigRead).
  let newestFailedRead = null;

  function noteFailedRead(seq, read, err) {
    if (newestFailedRead && newestFailedRead.seq === seq && newestFailedRead.read > read) return;
    newestFailedRead = { seq, read, message: err.detail || err.message };
  }

  /** Apply read `read`'s config to VM `name`. A config is on screen now, so a select
   *  error page it may have replaced goes. */
  function applyConfigRead(seq, read, name, config) {
    configReadsApplied = read;
    set((prev) => ({ vmConfig: config, configLoading: false, errors: withoutError(prev.errors, 'select', name) }));
  }

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
    set((prev) => ({
      selectedVM: match.name,
      renamedSelection: { from: selectedVM, to: match.name },
      errors: withErrorsRenamed(prev.errors, selectedVM, match.name),
    }));
    startStatsSSE(match.name);
    queueMicrotask(() => {
      get().refreshSelectedVM();
    });
  }

  return {
    vms: [],
    selectedVM: null,
    vmConfig: null,
    vmStats: null,
    configLoading: false,
    /** `{ [name]: action }`: the action in flight on each VM (see above). */
    actions: {},
    /** `{ [key]: { owner, vm, message } }`: the errors shown until dismissed (see above). */
    errors: {},
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
        set((prev) => ({ vms, listLoaded: true, listError: null, errors: withoutErrorsOfVanished(prev.errors, new Set(vms.map((v) => v.name))) }));

        const { selectedVM, vmConfig, configLoading, actions } = get();
        // Skip auto-deselect while a select or action is in flight — the VM may
        // legitimately not be in the list yet (post-create race) or be there
        // under its prior name (post-rename race). Subsequent SSE frames will
        // deselect once configLoading and the actions clear if it is truly gone.
        if (selectedVM && !vms.find(v => v.name === selectedVM) && !configLoading && !anyActionInFlight(actions)
          && !get().errors[errorKey('select', selectedVM)]) {
          get().deselectVM();
        } else if (selectedVM && vmConfig) {
          const vm = vms.find(v => v.name === selectedVM);
          const merged = vm && mergeListFields(vmConfig, vm);
          if (merged) set({ vmConfig: merged });
        }
      } catch (err) {
        set((prev) => ({ errors: withError(prev.errors, 'list', null, err.message), listError: err.detail || err.message }));
      }
    },

    startVMListSSE: () => {
      if (listCloseFn) return;
      changesCloseFn = subscribeChanges(['vm'], (change) => {
        const { selectedVM } = get();
        if (!selectedVM) return undefined;
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
          // vmConfig still gets populated from getVM — a stuck-stale state. Nor while
          // the view shows the select's error page: it stays until the user navigates.
          if (
            state.selectedVM &&
            !data.find((v) => v.name === state.selectedVM) &&
            !state.configLoading &&
            !anyActionInFlight(state.actions) &&
            !state.errors[errorKey('select', state.selectedVM)]
          ) {
            get().deselectVM();
          }
          set((prev) => {
            const next = {
              vms: data,
              listLoaded: true,
              listError: null,
              errors: withoutErrorsOfVanished(prev.errors, new Set(data.map((x) => x.name))),
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
      set((prev) => ({
        selectedVM: name, vmConfig: seed, vmStats: null, configLoading: true,
        errors: withoutError(prev.errors, 'select', name),
      }));
      startStatsSSE(name);
      const read = ++configReadsSent;
      try {
        const config = await vmApi.getVM(name);
        if (seq !== selectionSeq) return;
        if (read <= configReadsApplied) {
          set({ configLoading: false });
          return;
        }
        applyConfigRead(seq, read, name, config);
      } catch (err) {
        if (seq !== selectionSeq) return;
        noteFailedRead(seq, read, err);
        /* A newer read already applied, or still on its way, has the say: the view stays
         * loading (no section renders the list seed as the config) until it settles. */
        if (read !== configReadsSent || read <= configReadsApplied) return;
        set((prev) => ({ vmConfig: null, configLoading: false, errors: withError(prev.errors, 'select', name, err.message) }));
      }
    },

    deselectVM: () => {
      stopStatsSSE();
      selectionSeq += 1;
      // configLoading is reset here because the in-flight select's response is now dropped.
      set({ selectedVM: null, vmConfig: null, vmStats: null, configLoading: false });
    },

    /** Dismiss one error (`owner`, `vm`): never touches an action in flight. */
    dismissError: (owner, vm) => set((s) => ({ errors: withoutError(s.errors, owner, vm) })),
    /** Show a command's failure as VM `name`'s action error (the detail view's banner). */
    reportActionError: (name, message) => set((s) => ({ errors: withError(s.errors, 'action', name, message) })),

    /**
     * Re-read the selected VM's config. Never rejects: a failure is the VM's `refresh`
     * error, the detail view's dismissible banner over the config still shown, unless
     * a newer read is already on its way. A command waiting on the re-read
     * (runVMCommand) resolves either way.
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
        if (seq !== selectionSeq) return;
        noteFailedRead(seq, read, err);
        if (read !== configReadsSent || read <= configReadsApplied) return;
        if (get().configLoading) {
          // The last read of a select that never got its config: the error page.
          set((prev) => ({ vmConfig: null, configLoading: false, errors: withError(prev.errors, 'select', selectedVM, err.message) }));
          return;
        }
        set((prev) => ({ errors: withError(prev.errors, 'refresh', selectedVM, `Couldn't refresh this VM: ${err.detail || err.message}`) }));
        return;
      }
      if (seq !== selectionSeq || read <= configReadsApplied) return;
      applyConfigRead(seq, read, selectedVM, config);
    },

    /**
     * Run one action on VM `name`, busy in `actions[name]` while it runs. Resolves whether
     * it succeeded. Its failure becomes the VM's action error, replacing an earlier one; a
     * success leaves an earlier error until it is dismissed. Only touches the selection
     * when it is `name`.
     */
    async withAction(name, actionName, fn) {
      set((s) => ({ actions: withBusy(s.actions, name, actionName) }));
      /* The new state arrives on the `vms` topic and the stats stream: no follow-up GET. */
      try {
        await fn();
        set((s) => ({ actions: withBusy(s.actions, name, null) }));
        if (actionName === 'delete' && get().selectedVM === name) get().deselectVM();
        return true;
      } catch (err) {
        set((s) => ({ actions: withBusy(s.actions, name, null), errors: withError(s.errors, 'action', name, err.message) }));
        return false;
      }
    },

    startVM: async (name) => {
      return get().withAction(name, 'start', async () => awaitJob(JOB_KIND.VM_START, await vmApi.startVM(name)));
    },
    /* Suspend and resume stay busy until a `vms` frame shows the VM out of the state it
     * was in (suspend: no longer running; resume: no longer paused).
     * Stop (an ACPI shutdown) and reboot are requests the guest may ignore, so they
     * end at the ack: the list shows the VM stopping when it does. */
    stopVM: async (name) => {
      return get().withAction(name, 'stop', () => vmApi.stopVM(name));
    },
    forceStopVM: async (name) => {
      return get().withAction(name, 'force-stop', async () => awaitJob(JOB_KIND.VM_FORCE_STOP, await vmApi.forceStopVM(name)));
    },
    rebootVM: async (name) => {
      return get().withAction(name, 'reboot', () => vmApi.rebootVM(name));
    },
    suspendVM: async (name) => {
      return get().withAction(name, 'suspend', () =>
        sendAndAwaitTopic('vms', () => vmApi.suspendVM(name), listShowsLeft(name, 'running')));
    },
    resumeVM: async (name) => {
      return get().withAction(name, 'resume', () =>
        sendAndAwaitTopic('vms', () => vmApi.resumeVM(name), listShowsLeft(name, 'paused')));
    },
    deleteVM: async (name, deleteDisks) => {
      return get().withAction(name, 'delete', async () =>
        awaitJob(JOB_KIND.VM_DELETE, await vmApi.deleteVM(name, deleteDisks)));
    },
  };
});

/**
 * Send a command that changes VM `name` (its name after a rename) and resolve with
 * its ack once the client holds the new state: the `{ kind: 'vm', id: name }`
 * frame has arrived and every re-read the open detail view started for it (the
 * store's config, the USB and cloud-init sections) has settled. The control that
 * sent it stays busy until then. A command error rejects; a failed re-read doesn't,
 * since the ack succeeded, and shows in its own view.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
export function runVMCommand(name, send) {
  return sendAndAwaitChange('vm', name, send);
}
