import { useMemo } from 'react';

import {
  assertChangeKind, assertTopic, sendAndAwaitChange, sendAndAwaitTopic,
} from '../api/events.js';
import { errorText } from '../api/errors.js';
import { useRecord } from '../hooks/useRecord.js';
import { awaitJob } from './backgroundJobsStore.js';
import { createStreamStore, liveData, streamSource, topicSource } from './streamStore.js';
import {
  renamesBetween, withError, withoutError, withoutErrorsOfVanished, withErrorsRenamed, withBusy,
} from './workloadActions.js';

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
 * A workload's config as its page shows it: the record, with the list item's `fields`
 * laid over it (absent ones null) and the stats stream's run state over that.
 */
export function liveConfig(config, item, fields, liveState) {
  if (config == null) return null;
  const next = { ...config };
  if (item) for (const field of fields) next[field] = item[field] ?? null;
  if (liveState != null) next.state = liveState;
  return next;
}

/**
 * The store of one kind of workload (VMs, containers): one base, and a spec with
 * what really differs between the two. It mirrors the kind's list topic
 * (`createStreamStore`: `data` is the list), names the workload a page shows
 * (`selected`, whose stats are a scoped stream of their own, `useStatsStore`),
 * holds each workload's action in flight and its action error (workloadActions.js),
 * and runs the commands. A workload's configuration is a record (`useWorkload`).
 *
 * @param {object} spec
 * @param {string} spec.listTopic — the list's `TOPIC`
 * @param {string} spec.changeKind — the `CHANGE_KIND` naming a workload's config
 * @param {string} spec.record — the `RECORD` kind of a workload's config
 * @param {(item: object) => object} spec.seed — what a page's header paints from the
 *   list item while the config loads
 * @param {string[]} spec.listFields — the config fields the list keeps current
 * @param {(name: string) => string} spec.statsUrl — a workload's stats stream
 * @param {(command: object) => object} spec.commands — the kind's commands, built from
 *   `command`: `{ job(name, action, start), atAck(name, action, send),
 *   untilListLeaves(name, action, fromState, send) }`
 * @param {(set: Function, get: Function) => object} [spec.extend] — state and actions
 *   only one kind has
 */
export function createWorkloadStore(spec) {
  assertTopic(spec.listTopic);
  assertChangeKind(spec.changeKind);

  const useStatsStore = createStreamStore({ source: streamSource(spec.statsUrl) });

  /** The last list seen: a list's renames are read against it. A refusal empties the
   *  store's data but is no list, so it does not move this. */
  let lastList = null;

  const useStore = createStreamStore({
    source: topicSource(spec.listTopic),
    toData: (frame) => (Array.isArray(frame) ? frame : undefined),
    /* A renamed workload's errors follow it to its new name; a deleted one's go. */
    onData: (list, set) => {
      if (!list) return;
      const previous = lastList;
      lastList = list;
      set((prev) => {
        let errors = prev.errors;
        for (const [from, to] of renamesBetween(previous, list)) errors = withErrorsRenamed(errors, from, to);
        return { errors: withoutErrorsOfVanished(errors, new Set(list.map((w) => w.name))) };
      });
    },
    extend: (set, get) => {
      /** Run one action on workload `name`, busy in `actions[name]` while it runs.
       *  Resolves whether it succeeded. Its error slot is cleared when it begins, and
       *  holds its failure. */
      async function withAction(name, action, fn) {
        set((s) => ({ actions: withBusy(s.actions, name, action), errors: withoutError(s.errors, 'action', name) }));
        /* The new state arrives on the list topic and the stats stream: no follow-up GET. */
        try {
          await fn();
          set((s) => ({ actions: withBusy(s.actions, name, null) }));
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

      return {
        /** The workload a page shows, while it shows it. */
        selected: null,
        /** `{ [name]: action }`: the action in flight on each workload. */
        actions: {},
        /** `{ [key]: { owner, vm, message } }`: each workload's action error, shown until dismissed. */
        errors: {},

        /** A page shows workload `name`: its stats stream opens. */
        select: (name) => {
          useStatsStore.getState().disconnect();
          set({ selected: name });
          useStatsStore.getState().connect(name);
        },

        deselect: () => {
          useStatsStore.getState().disconnect();
          set({ selected: null });
        },

        /** Workload `from` is named `to` now: its undismissed errors go with it. */
        followRename: (from, to) => set((prev) => ({ errors: withErrorsRenamed(prev.errors, from, to) })),

        /** Dismiss one error (`owner`, `vm`): never touches an action in flight. */
        dismissError: (owner, vm) => set((s) => ({ errors: withoutError(s.errors, owner, vm) })),
        /** Show a command's failure as workload `name`'s action error (the detail view's banner). */
        reportActionError: (name, message) => set((s) => ({ errors: withError(s.errors, 'action', name, message) })),

        ...spec.commands(command),
        ...spec.extend?.(set, get),
      };
    },
  });

  /**
   * Workload `name` as its page shows it: its config record (`useRecord`), with what
   * is live laid over it — the list item's fields (`spec.listFields`), which change on
   * every event, and the run state of its stats stream while it is the selected one.
   * `seed` is what the header paints from the list item before the config loads.
   */
  function useWorkload(name) {
    const record = useRecord(spec.record, name);
    const item = useStore((s) => s.data?.find((w) => w.name === name) ?? null);
    const statsState = useStatsStore((s) => liveData(s)?.state ?? null);
    const selected = useStore((s) => s.selected === name);
    const liveState = selected ? statsState : null;
    const config = useMemo(() => liveConfig(record.data, item, spec.listFields, liveState), [record.data, item, liveState]);
    const seed = useMemo(() => (item ? spec.seed(item) : null), [item]);
    return { record, config, seed, item };
  }

  /**
   * Send a command that changes workload `name` (its name after a rename) and resolve
   * with its ack once the client holds the new state: the `changes` frame naming it has
   * arrived and every re-read the open view started for it has settled (or 30 s
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

  return { useStore, useStatsStore, useWorkload, runCommand };
}
