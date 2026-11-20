import { create } from 'zustand';
import * as containerApi from '../api/containers.js';
import { createSSE } from '../api/sse.js';
import { sendAndAwaitChange, sendAndAwaitTopic, subscribeChanges, subscribeTopic } from '../api/events.js';
import { JOB_KIND } from '../api/jobs.js';
import {
  errorKey, withError, withoutError, withoutErrorsOfVanished, withErrorsRenamed, withBusy, anyActionInFlight,
} from './workloadActions.js';
import { awaitJob, useBackgroundJobsStore } from './backgroundJobsStore.js';
import { errorText } from '../api/errors.js';

/** Add a container job's row, the container its subject, and wait for its result. */
function awaitContainerJob(accepted, kind, name) {
  return awaitJob(useBackgroundJobsStore.getState().addJob({ ...accepted, kind, subject: { type: 'container', name } }));
}

/** Same scheduled restart (or both none)? Compared by value — list pushes carry fresh objects. */
function sameScheduledRestart(a, b) {
  if (!a || !b) return !a && !b;
  return a.attempt === b.attempt && a.at === b.at;
}

/**
 * The list topic is the live source for a workload's run state; carry its
 * `state`, `scheduledRestart` and in-force `pendingRestart` into the selected
 * container's config, so a restart done elsewhere drops the badge here.
 * Returns the updated config, or null when nothing changed.
 */
function configSyncedFromListItem(config, item) {
  if (!item) return null;
  const scheduledRestart = item.scheduledRestart ?? null;
  const pendingRestart = item.pendingRestart ?? null;
  const unchanged = item.state === config.state
    && sameScheduledRestart(scheduledRestart, config.scheduledRestart)
    && (pendingRestart?.since ?? null) === (config.pendingRestart?.since ?? null);
  if (unchanged) return null;
  const next = { ...config, state: item.state, scheduledRestart };
  if (pendingRestart) next.pendingRestart = pendingRestart;
  else delete next.pendingRestart;
  return next;
}

/** A `containers` frame matcher: the list shows container `name` out of `state` (moved
 *  on, or gone; an error frame never matches). */
function listShowsLeft(name, state) {
  return (list) => {
    if (!Array.isArray(list)) return false;
    const item = list.find((c) => c.name === name);
    return !item || item.state !== state;
  };
}

/* Busy and errors live apart, as in vmStore (workloadActions.js): `actions[name]` is
 * the action in flight, `errors` what the detail view shows until dismissed. */
export const useContainerStore = create((set, get) => {
  let listCloseFn = null;
  let changesCloseFn = null;
  let statsCloseFn = null;
  // Bumped on every selection change; a getContainer response is applied only if
  // the selection did not change while it was in flight (see vmStore).
  let selectionSeq = 0;
  // Every getContainer of the selection is numbered; only a read newer than the last
  // applied one lands (see vmStore).
  let configReadsSent = 0;
  let configReadsApplied = 0;
  // The newest read of the current selection that failed: `{ seq, read, message }`.
  let newestFailedRead = null;

  function noteFailedRead(seq, read, err) {
    if (newestFailedRead && newestFailedRead.seq === seq && newestFailedRead.read > read) return;
    newestFailedRead = { seq, read, message: errorText(err) };
  }

  /** Apply read `read`'s config to container `name`: it replaces a select error page,
   *  and a newer read that already failed (still the newest sent, not dismissed)
   *  becomes the container's `refresh` error, since the config shown predates it. */
  function applyConfigRead(seq, read, name, config) {
    configReadsApplied = read;
    const failed = newestFailedRead && newestFailedRead.seq === seq ? newestFailedRead : null;
    const raise = failed && failed.read > read && failed.read === configReadsSent;
    if (failed && !raise) newestFailedRead = null;
    set((prev) => {
      let errors = withoutError(prev.errors, 'select', name);
      if (raise) errors = withError(errors, 'refresh', name, `Couldn't refresh this container: ${failed.message}`);
      return { containerConfig: config, loading: false, errors };
    });
  }

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

  /** Follow container `from`'s rename to `to`: its undismissed errors go with it, and
   *  the selection moves when it is `from`. */
  function followRename(from, to) {
    const moveSelection = get().selectedContainer === from;
    if (moveSelection) {
      stopStatsSSE();
      selectionSeq += 1;
    }
    set((prev) => ({
      ...(moveSelection ? { selectedContainer: to } : {}),
      errors: withErrorsRenamed(prev.errors, from, to),
    }));
    if (moveSelection) startStatsSSE(to);
  }

  /** If the selected name vanished from the list but the same uuid appears under a new
   *  name (renamed in another tab), follow it. */
  function migrateSelectionIfRenamed(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    const { selectedContainer, containerConfig } = get();
    if (!selectedContainer) return;
    if (list.some((c) => c.name === selectedContainer)) return;
    const uuid = containerConfig?.uuid;
    if (!uuid) return;
    const match = list.find((c) => c.uuid === uuid);
    if (!match || match.name === selectedContainer) return;
    followRename(selectedContainer, match.name);
    set({ renamedSelection: { from: selectedContainer, to: match.name } });
    queueMicrotask(() => {
      get().refreshSelectedContainer();
    });
  }

  /** Auto-deselect a selected container the list no longer shows — unless a select or
   *  action is in flight (it may not be listed yet: post-create race), or the view
   *  shows its select error page (it stays until the user navigates). */
  function deselectIfGone(list) {
    const state = get();
    if (
      state.selectedContainer
      && !list.find((c) => c.name === state.selectedContainer)
      && !state.loading
      && !anyActionInFlight(state.actions)
      && !state.errors[errorKey('select', state.selectedContainer)]
    ) {
      get().deselectContainer();
    }
  }

  function applyList(list) {
    set((prev) => {
      const next = {
        containers: list,
        listLoaded: true,
        listError: null,
        errors: withoutErrorsOfVanished(prev.errors, new Set(list.map((c) => c.name))),
      };
      if (prev.selectedContainer && prev.containerConfig) {
        const synced = configSyncedFromListItem(
          prev.containerConfig,
          list.find((c) => c.name === prev.selectedContainer),
        );
        if (synced) next.containerConfig = synced;
      }
      return next;
    });
  }

  return {
    containers: [],
    selectedContainer: null,
    containerConfig: null,
    containerStats: null,
    loading: false,
    /** `{ [name]: action }`: the action in flight on each container. */
    actions: {},
    /** `{ [key]: { owner, vm, message } }`: the errors shown until dismissed (workloadActions.js). */
    errors: {},
    /** The list has loaded once; `listError` is the list stream's last error (the list shown is the last good one). */
    listLoaded: false,
    listError: null,
    /** `{ from, to }` after the selection followed a rename seen on the list, until the route follows it. */
    renamedSelection: null,

    clearRenamedSelection: () => set({ renamedSelection: null }),

    imageUpdateCheck: {
      running: false,
      ref: null,
      lastCheckedAt: null,
      imagesChecked: 0,
      imagesUpdated: 0,
      flaggedContainers: 0,
      lastError: null,
      /** The check's job: its row in the jobs store holds the progress. */
      jobId: null,
    },

    fetchContainers: async () => {
      try {
        const containers = await containerApi.listContainers();
        migrateSelectionIfRenamed(containers);
        deselectIfGone(containers);
        applyList(containers);
      } catch (err) {
        set((prev) => ({ errors: withError(prev.errors, 'list', null, errorText(err)), listError: errorText(err) }));
      }
    },

    startContainerListSSE: () => {
      if (listCloseFn) return;
      get().fetchContainers();
      changesCloseFn = subscribeChanges(['container'], (change) => {
        const { selectedContainer } = get();
        if (!selectedContainer) return undefined;
        if (change.kind === 'all' || change.id === selectedContainer) return get().refreshSelectedContainer();
        return undefined;
      });
      listCloseFn = subscribeTopic(
        'containers',
        (data) => {
          if (data && !Array.isArray(data) && data.error) {
            set({ listError: errorText(data) });
            return;
          }
          if (!Array.isArray(data)) return;
          migrateSelectionIfRenamed(data);
          // Empty [] can be transient (race, parse glitch); deselecting clears the panel and looks like a blank page.
          if (data.length > 0) deselectIfGone(data);
          applyList(data);
        },
      );
    },

    stopContainerListSSE: () => {
      if (listCloseFn) {
        listCloseFn();
        listCloseFn = null;
      }
      if (changesCloseFn) {
        changesCloseFn();
        changesCloseFn = null;
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
            uuid: listItem.uuid ?? null,
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
      set((prev) => ({
        selectedContainer: name, containerConfig: seed, containerStats: null, loading: true,
        // The error page of the container being left goes with it, as does an earlier one of this name.
        errors: withoutError(withoutError(prev.errors, 'select', prev.selectedContainer), 'select', name),
      }));
      startStatsSSE(name);
      const read = ++configReadsSent;
      try {
        const config = await containerApi.getContainer(name);
        if (seq !== selectionSeq) return;
        if (read <= configReadsApplied) {
          set({ loading: false });
          return;
        }
        applyConfigRead(seq, read, name, config);
      } catch (err) {
        if (seq !== selectionSeq) return;
        noteFailedRead(seq, read, err);
        /* A newer read already applied, or still on its way, has the say: the view stays
         * loading until it settles. Otherwise the seed lacks env, mounts and network, so
         * the panel shows the error page rather than empty sections. */
        if (read !== configReadsSent || read <= configReadsApplied) return;
        set((prev) => ({ containerConfig: null, loading: false, errors: withError(prev.errors, 'select', name, errorText(err)) }));
      }
    },

    deselectContainer: () => {
      stopStatsSSE();
      selectionSeq += 1;
      // loading is reset here because the in-flight select's response is now dropped.
      // The error page of the container being left goes with it.
      set((prev) => ({
        selectedContainer: null, containerConfig: null, containerStats: null, loading: false,
        errors: prev.selectedContainer ? withoutError(prev.errors, 'select', prev.selectedContainer) : prev.errors,
      }));
    },

    /** Dismiss one error (`owner`, `vm`): never touches an action in flight. */
    dismissError: (owner, vm) => {
      if ((owner === 'select' || owner === 'refresh') && vm === get().selectedContainer) newestFailedRead = null;
      set((s) => ({ errors: withoutError(s.errors, owner, vm) }));
    },
    /** Show a command's failure as container `name`'s action error (the detail view's banner). */
    reportActionError: (name, message) => set((s) => ({ errors: withError(s.errors, 'action', name, message) })),

    /** This tab renamed container `from` to `to` and follows it from the request. */
    followRename: (from, to) => followRename(from, to),

    /**
     * Re-read the selected container's config. Never rejects: a failure is the
     * container's `refresh` error (the banner), or its error page while no config is on
     * screen, unless a newer read is already on its way.
     */
    refreshSelectedContainer: async () => {
      const { selectedContainer } = get();
      if (!selectedContainer) return;
      const seq = selectionSeq;
      const read = ++configReadsSent;
      let config;
      try {
        config = await containerApi.getContainer(selectedContainer);
      } catch (err) {
        if (seq !== selectionSeq) return;
        noteFailedRead(seq, read, err);
        if (read !== configReadsSent || read <= configReadsApplied) return;
        if (get().loading || !get().containerConfig) {
          set((prev) => ({ containerConfig: null, loading: false, errors: withError(prev.errors, 'select', selectedContainer, errorText(err)) }));
          return;
        }
        set((prev) => ({ errors: withError(prev.errors, 'refresh', selectedContainer, `Couldn't refresh this container: ${errorText(err)}`) }));
        return;
      }
      if (seq !== selectionSeq || read <= configReadsApplied) return;
      applyConfigRead(seq, read, selectedContainer, config);
    },

    /**
     * Run one action on container `name`, busy in `actions[name]` while it runs. Resolves
     * whether it succeeded. Its failure becomes the container's action error, replacing
     * an earlier one; a success leaves an earlier error until it is dismissed.
     */
    async withAction(name, actionName, fn) {
      set((s) => ({ actions: withBusy(s.actions, name, actionName) }));
      /* The new state arrives on the `containers` topic and the stats stream: no follow-up GET. */
      try {
        await fn();
        set((s) => ({ actions: withBusy(s.actions, name, null) }));
        if (actionName === 'delete' && get().selectedContainer === name) get().deselectContainer();
        return true;
      } catch (err) {
        set((s) => ({ actions: withBusy(s.actions, name, null), errors: withError(s.errors, 'action', name, errorText(err)) }));
        return false;
      }
    },

    startContainer: async (name) => get().withAction(name, 'start', async () =>
      awaitContainerJob(await containerApi.startContainerApi(name), JOB_KIND.CONTAINER_START, name)),
    stopContainer: async (name) => get().withAction(name, 'stop', async () =>
      awaitContainerJob(await containerApi.stopContainerApi(name), JOB_KIND.CONTAINER_STOP, name)),
    restartContainer: async (name) => get().withAction(name, 'restart', async () =>
      awaitContainerJob(await containerApi.restartContainerApi(name), JOB_KIND.CONTAINER_RESTART, name)),
    /* Kill (SIGKILL) always ends the task: it stays busy until a `containers` frame
     * shows the container out of `running`. */
    killContainer: async (name) => get().withAction(name, 'kill', () =>
      sendAndAwaitTopic('containers', () => containerApi.killContainerApi(name), listShowsLeft(name, 'running'))),
    deleteContainer: async (name, deleteFiles) => get().withAction(name, 'delete', async () =>
      awaitContainerJob(await containerApi.deleteContainerApi(name, deleteFiles), JOB_KIND.CONTAINER_DELETE, name)),

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
        imageUpdateCheck: { ...prev.imageUpdateCheck, running: true, ref, lastError: null, jobId: null },
      }));

      try {
        const jobId = useBackgroundJobsStore.getState().addJob({
          ...await containerApi.checkContainerImageUpdates(ref), kind: JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK,
        });
        set((prev) => ({ imageUpdateCheck: { ...prev.imageUpdateCheck, jobId } }));
        const result = await awaitJob(jobId);
        set((prev) => ({
          imageUpdateCheck: {
            ...prev.imageUpdateCheck,
            running: false,
            ref: null,
            jobId: null,
            lastCheckedAt: result.lastCheckedAt,
            imagesChecked: result.checked,
            imagesUpdated: result.updated,
            flaggedContainers: result.flaggedContainers,
          },
        }));
        // The backend writes the flagged containers' config after the check:
        // the `containers` topic pushes the list, the open detail re-reads here.
        get().refreshSelectedContainer();
      } catch (err) {
        set((prev) => ({
          imageUpdateCheck: { ...prev.imageUpdateCheck, running: false, ref: null, jobId: null, lastError: errorText(err) },
        }));
      }
    },
  };
});

/**
 * Send a command that changes container `name` (its name after a rename) and resolve
 * with its ack once the client holds the new state: the `{ kind: 'container', id }`
 * frame has arrived and every re-read the open detail view started for it has
 * settled (or 30 s passed). A command error rejects; a failed re-read doesn't, since
 * the ack succeeded, and shows in its own view.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
export function runContainerCommand(name, send) {
  return sendAndAwaitChange('container', name, send);
}
