import { sendAndAwaitChange, sendAndAwaitTopic, subscribeChanges } from '../api/events.js';
import { errorText } from '../api/errors.js';
import { CHANGE_KIND } from '../../../shared/wireNames.js';
import { awaitJob } from './backgroundJobsStore.js';
import { createStreamStore, streamSource, topicSource } from './streamStore.js';
import {
  errorKey, withError, withoutError, withoutErrorsOfVanished, withErrorsRenamed, withBusy, anyActionInFlight,
} from './workloadActions.js';

/** The list fields of `item` the config carries, absent ones as null. */
function listFieldsOf(item, fields) {
  return Object.fromEntries(fields.map((field) => [field, item[field] ?? null]));
}

/**
 * The list topic is the live source of a workload's run state: the config of the
 * selected workload takes the spec's list fields from its list item, so a change
 * made elsewhere (a stop, a restart that drops the badge) shows here. Returns the
 * updated config, or null when nothing changed (compared by value: list frames
 * carry fresh objects).
 */
function configSyncedFromListItem(config, item, fields) {
  if (!item) return null;
  const fromList = listFieldsOf(item, fields);
  const unchanged = fields.every((field) => JSON.stringify(fromList[field]) === JSON.stringify(config[field] ?? null));
  return unchanged ? null : { ...config, ...fromList };
}

/** A list frame matcher: the list shows workload `name` out of `state`, the one it was
 *  in before the command — moved on, or gone (an error frame never matches). */
function listShowsLeft(name, state) {
  return (list) => {
    if (!Array.isArray(list)) return false;
    const item = list.find((w) => w.name === name);
    return !item || item.state !== state;
  };
}

/**
 * The store of one kind of workload (VMs, containers): one base, and a spec with
 * what really differs between the two. It mirrors the kind's list topic
 * (`createStreamStore`: `data` is the list, `connected`, `error`), holds the
 * selected workload's config, each workload's action in flight and the errors
 * the detail view shows (workloadActions.js), and runs the commands. The
 * selected workload's stats are a scoped stream of their own, `useStatsStore`.
 *
 * @param {object} spec
 * @param {string} spec.noun — what the error texts call one ("VM", "container")
 * @param {string} spec.listTopic — the list's `TOPIC`
 * @param {string} spec.changeKind — the `CHANGE_KIND` naming a workload's config
 * @param {(name: string) => Promise<object>} spec.get — a workload's config GET
 * @param {(item: object) => object} spec.seed — what the header paints from the list
 *   item while the config loads
 * @param {string[]} spec.listFields — the config fields the list keeps current
 * @param {(name: string) => string} spec.statsUrl — the selected workload's stats stream
 * @param {(command: object) => object} spec.commands — the kind's commands, built from
 *   `command`: `{ job(name, action, start), atAck(name, action, send),
 *   untilListLeaves(name, action, fromState, send) }`
 * @param {(set: Function, get: Function, store: { refreshSelected: Function }) => object} [spec.extend]
 *   — state and actions only one kind has
 */
export function createWorkloadStore(spec) {
  /* The selection the stats stream is open for: its state is carried into that
   * workload's config. */
  let statsFor = null;
  let useStore = null;

  const useStatsStore = createStreamStore({
    source: streamSource(spec.statsUrl),
    onData: (stats) => {
      const { config, selected } = useStore.getState();
      if (!config || !stats || selected !== statsFor || stats.state == null || stats.state === config.state) return;
      useStore.setState({ config: { ...config, state: stats.state } });
    },
  });

  function connectStats(name) {
    useStatsStore.getState().disconnect();
    statsFor = name;
    useStatsStore.getState().connect(name);
  }

  function disconnectStats() {
    statsFor = null;
    useStatsStore.getState().disconnect();
  }

  // Bumped on every selection change (select, deselect, rename-follow). A config
  // read is applied only if no selection change happened while it was in flight:
  // a slow answer for the previous workload must not overwrite the current one,
  // or the header actions would target the wrong one.
  let selectionSeq = 0;
  // Every config read of the selection is numbered; an answer is applied only when it
  // is newer than the last one applied, so two quick re-reads can't land out of order.
  let configReadsSent = 0;
  let configReadsApplied = 0;
  // The newest read of the current selection that failed: `{ seq, read, message }`. An
  // older read landing after it must not hide it (see applyConfigRead).
  let newestFailedRead = null;

  /* The list topic, and with it the `changes` cue of the selected workload's config. */
  const listTopic = topicSource(spec.listTopic);
  const source = {
    ...listTopic,
    open: (handlers) => {
      const closeList = listTopic.open(handlers);
      const closeChanges = subscribeChanges([spec.changeKind], (change) => {
        const { selected, refreshSelected } = useStore.getState();
        if (!selected) return undefined;
        if (change.kind === CHANGE_KIND.ALL || change.id === selected) return refreshSelected();
        return undefined;
      });
      return () => {
        closeList();
        closeChanges();
      };
    },
  };

  useStore = createStreamStore({
    source,
    toData: (frame) => (Array.isArray(frame) ? frame : undefined),
    onData: (list) => { if (list) applyList(list); },
    extend: (set, get) => {
      function noteFailedRead(seq, read, err) {
        if (newestFailedRead && newestFailedRead.seq === seq && newestFailedRead.read > read) return;
        newestFailedRead = { seq, read, message: errorText(err) };
      }

      /** Apply read `read`'s config to workload `name`. A config is on screen now, so a
       *  select error page it may have replaced goes. When the newest read sent has
       *  already failed (and the user hasn't dismissed it), the config shown predates
       *  it: that failure becomes the workload's `refresh` error, the banner. */
      function applyConfigRead(seq, read, name, config) {
        configReadsApplied = read;
        const failed = newestFailedRead && newestFailedRead.seq === seq ? newestFailedRead : null;
        const raise = failed && failed.read > read && failed.read === configReadsSent;
        if (failed && !raise) newestFailedRead = null;
        set((prev) => {
          let errors = withoutError(prev.errors, 'select', name);
          if (raise) errors = withError(errors, 'refresh', name, `Couldn't refresh this ${spec.noun}: ${failed.message}`);
          return { config, configLoading: false, errors };
        });
      }

      /** Run one action on workload `name`, busy in `actions[name]` while it runs.
       *  Resolves whether it succeeded. Its error slot is cleared when it begins, and
       *  holds its failure; only touches the selection when it is `name`. */
      async function withAction(name, action, fn) {
        set((s) => ({ actions: withBusy(s.actions, name, action), errors: withoutError(s.errors, 'action', name) }));
        /* The new state arrives on the list topic and the stats stream: no follow-up GET. */
        try {
          await fn();
          set((s) => ({ actions: withBusy(s.actions, name, null) }));
          if (action === 'delete' && get().selected === name) get().deselect();
          return true;
        } catch (err) {
          set((s) => ({ actions: withBusy(s.actions, name, null), errors: withError(s.errors, 'action', name, errorText(err)) }));
          return false;
        }
      }

      const command = {
        /** A command that runs as a job: busy until the job ends. */
        job: (name, action, start) => withAction(name, action, async () => awaitJob((await start()).jobId)),
        /** A request the workload may ignore: busy until the ack. */
        atAck: (name, action, send) => withAction(name, action, send),
        /** Busy until a list frame shows the workload out of `fromState`. */
        untilListLeaves: (name, action, fromState, send) => withAction(name, action, () =>
          sendAndAwaitTopic(spec.listTopic, send, listShowsLeft(name, fromState))),
      };

      const refreshSelected = async () => {
        const { selected } = get();
        if (!selected) return;
        const seq = selectionSeq;
        const read = ++configReadsSent;
        let config;
        try {
          config = await spec.get(selected);
        } catch (err) {
          if (seq !== selectionSeq) return;
          noteFailedRead(seq, read, err);
          if (read !== configReadsSent || read <= configReadsApplied) return;
          if (get().configLoading || !get().config) {
            // No config on screen (a select still loading, or its error page): the error page.
            set((prev) => ({ config: null, configLoading: false, errors: withError(prev.errors, 'select', selected, errorText(err)) }));
            return;
          }
          set((prev) => ({ errors: withError(prev.errors, 'refresh', selected, `Couldn't refresh this ${spec.noun}: ${errorText(err)}`) }));
          return;
        }
        if (seq !== selectionSeq || read <= configReadsApplied) return;
        applyConfigRead(seq, read, selected, config);
      };

      return {
        /** The selected workload's name, its config (the list item's seed while it loads). */
        selected: null,
        config: null,
        configLoading: false,
        /** `{ [name]: action }`: the action in flight on each workload. */
        actions: {},
        /** `{ [key]: { owner, vm, message } }`: the errors shown until dismissed (workloadActions.js). */
        errors: {},
        /** `{ from, to }` after the selection followed a rename seen on the list, until the route follows it. */
        renamedSelection: null,

        clearRenamedSelection: () => set({ renamedSelection: null }),

        /** This tab renamed workload `from` to `to` and follows it from the request. */
        followRename: (from, to) => followRename(from, to),

        select: async (name) => {
          const listItem = (get().data ?? []).find((w) => w.name === name);
          const seq = ++selectionSeq;
          set((prev) => ({
            selected: name, config: listItem ? spec.seed(listItem) : null, configLoading: true,
            // The error page of the workload being left goes with it, as does an earlier one of this name.
            errors: withoutError(withoutError(prev.errors, 'select', prev.selected), 'select', name),
          }));
          connectStats(name);
          const read = ++configReadsSent;
          try {
            const config = await spec.get(name);
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
             * loading until it settles. Otherwise the seed lacks the config's detail, so the
             * view shows the error page rather than empty sections. */
            if (read !== configReadsSent || read <= configReadsApplied) return;
            set((prev) => ({ config: null, configLoading: false, errors: withError(prev.errors, 'select', name, errorText(err)) }));
          }
        },

        deselect: () => {
          disconnectStats();
          selectionSeq += 1;
          // configLoading is reset here because the in-flight select's answer is now dropped.
          // The error page of the workload being left goes with it (Escape, a sidebar click, Back).
          set((prev) => ({
            selected: null, config: null, configLoading: false,
            errors: prev.selected ? withoutError(prev.errors, 'select', prev.selected) : prev.errors,
          }));
        },

        /** Dismiss one error (`owner`, `vm`): never touches an action in flight. A dismissed
         *  read failure doesn't come back when an older read lands. */
        dismissError: (owner, vm) => {
          if ((owner === 'select' || owner === 'refresh') && vm === get().selected) newestFailedRead = null;
          set((s) => ({ errors: withoutError(s.errors, owner, vm) }));
        },
        /** Show a command's failure as workload `name`'s action error (the detail view's banner). */
        reportActionError: (name, message) => set((s) => ({ errors: withError(s.errors, 'action', name, message) })),

        /**
         * Re-read the selected workload's config. Never rejects: a failure is its
         * `refresh` error, the detail view's dismissible banner over the config still
         * shown (its error page while no config is on screen), unless a newer read is
         * already on its way. A command waiting on the re-read resolves either way.
         */
        refreshSelected,

        ...spec.commands(command),
        ...spec.extend?.(set, get, { refreshSelected }),
      };
    },
  });

  /** Follow workload `from`'s rename to `to`, the one way both paths take (this tab's
   *  own rename, and one seen on the list): its undismissed errors go with it, and the
   *  selection moves when it is `from`. */
  function followRename(from, to) {
    const moveSelection = useStore.getState().selected === from;
    if (moveSelection) {
      disconnectStats();
      selectionSeq += 1;
    }
    useStore.setState((prev) => ({
      ...(moveSelection ? { selected: to } : {}),
      errors: withErrorsRenamed(prev.errors, from, to),
    }));
    if (moveSelection) connectStats(to);
  }

  /** If the selected name vanished from the list but the same uuid appears under a new
   *  name (renamed in another tab), follow it. */
  function migrateSelectionIfRenamed(list) {
    if (list.length === 0) return;
    const { selected, config } = useStore.getState();
    if (!selected) return;
    if (list.some((w) => w.name === selected)) return;
    const uuid = config?.uuid;
    if (!uuid) return;
    const match = list.find((w) => w.uuid === uuid);
    if (!match || match.name === selected) return;
    followRename(selected, match.name);
    useStore.setState({ renamedSelection: { from: selected, to: match.name } });
    queueMicrotask(() => {
      useStore.getState().refreshSelected();
    });
  }

  /** Deselect a selected workload a non-empty list no longer shows, unless a select
   *  or action is in flight (it may not be listed yet: post-create race), or the view
   *  shows its select error page (it stays until the user navigates). An empty list
   *  never deselects: it may mean the manager is down. */
  function deselectIfGone(list) {
    const state = useStore.getState();
    if (
      list.length > 0
      && state.selected
      && !list.some((w) => w.name === state.selected)
      && !state.configLoading
      && !anyActionInFlight(state.actions)
      && !state.errors[errorKey('select', state.selected)]
    ) {
      state.deselect();
    }
  }

  /** What a list brings beyond itself: a rename
   *  followed, a vanished selection deselected, the errors of deleted workloads
   *  dropped, the selected config's list fields brought up to date. */
  function applyList(list) {
    migrateSelectionIfRenamed(list);
    deselectIfGone(list);
    useStore.setState((prev) => {
      const next = { errors: withoutErrorsOfVanished(prev.errors, new Set(list.map((w) => w.name))) };
      if (prev.selected && prev.config) {
        const synced = configSyncedFromListItem(prev.config, list.find((w) => w.name === prev.selected), spec.listFields);
        if (synced) next.config = synced;
      }
      return next;
    });
  }

  /**
   * Send a command that changes workload `name` (its name after a rename) and resolve
   * with its ack once the client holds the new state: the `changes` frame naming it has
   * arrived and every re-read the open detail view started for it has settled (or 30 s
   * passed). The control that sent it stays busy until then. A command error rejects; a
   * failed re-read doesn't, since the ack succeeded, and shows in its own view.
   *
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} send
   * @returns {Promise<T>}
   */
  function runCommand(name, send) {
    return sendAndAwaitChange(spec.changeKind, name, send);
  }

  return { useStore, useStatsStore, runCommand };
}
