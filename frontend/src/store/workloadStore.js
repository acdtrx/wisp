import { useMemo } from 'react';

import { assertTopic } from '../api/events.js';
import { errorText } from '../api/errors.js';
import { useRecord } from '../hooks/useRecord.js';
import { runCommand } from './commands.js';
import { createStreamStore, liveData, streamSource, topicSource } from './streamStore.js';
import { withEntry, withError, withErrorsRenamed, withoutError, withoutErrorsOfVanished } from './workloadActions.js';

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
 * @param {string} spec.record — the `RECORD` kind of a workload's config
 * @param {(item: object) => object} spec.seed — what a page's header paints from the
 *   list item while the config loads
 * @param {string[]} spec.listFields — the config fields the list keeps current
 * @param {(name: string) => string} spec.statsUrl — a workload's stats stream
 * @param {(command: object) => object} spec.commands — the kind's commands, built from
 *   `command`: `{ job(name, action, start), icon(name, send), atAck(name, action, send) }`
*/
export function createWorkloadStore(spec) {
  assertTopic(spec.listTopic);

  const useStatsStore = createStreamStore({ source: streamSource(spec.statsUrl) });

  const useStore = createStreamStore({
    source: topicSource(spec.listTopic),
    toData: (frame) => (Array.isArray(frame) ? frame : undefined),
    /* A workload the list no longer lists takes its error with it. */
    onData: (list, set) => {
      if (!list) return;
      set((prev) => ({ errors: withoutErrorsOfVanished(prev.errors, new Set(list.map((w) => w.name))) }));
    },
    extend: (set) => {
      /** Each slot's own run: an action's end clears a busy slot only while it still
       *  holds that run (a later action may have taken it). */
      let runs = 0;
      const owners = new Map();

      /** Run one action on workload `name`, busy in `slot[name]` (`actions`, or
       *  `iconChanges` for the icon) while it runs. Resolves whether it succeeded. The
       *  workload's one error slot is cleared when it begins, and holds its failure. */
      async function withAction(name, action, fn, slot = 'actions') {
        const run = ++runs;
        const owner = `${slot}:${name}`;
        owners.set(owner, run);
        set((s) => ({ [slot]: withEntry(s[slot], name, action), errors: withoutError(s.errors, name) }));
        const mine = () => owners.get(owner) === run;
        /* The new state arrives on the list topic and the stats stream: no follow-up GET. */
        try {
          await fn();
          set((s) => (mine() ? { [slot]: withEntry(s[slot], name, null) } : {}));
          return true;
        } catch (err) {
          set((s) => ({
            ...(mine() ? { [slot]: withEntry(s[slot], name, null) } : {}),
            errors: withError(s.errors, name, errorText(err)),
          }));
          return false;
        } finally {
          if (mine()) owners.delete(owner);
        }
      }

      const command = {
        /** A command that runs as a job: busy until the job ended (store/commands.js). */
        job: (name, action, start) => withAction(name, action, () => runCommand(start, { job: true })),
        /** The icon change: busy in its own control's slot until the ack, failing into
         *  the workload's error. */
        icon: (name, send) => withAction(name, 'icon', send, 'iconChanges'),
        /** A command that ends at its ack: busy until then. */
        atAck: (name, action, send) => withAction(name, action, send),
      };

      return {
        /** The workload a page shows, while it shows it. */
        selected: null,
        /** `{ [name]: action }`: the header action in flight on each workload. */
        actions: {},
        /** `{ [name]: 'icon' }`: an icon change in flight (its own control's busy state). */
        iconChanges: {},
        /** `{ [name]: message }`: each workload's action error, shown until dismissed. */
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

        /** Workload `from` is named `to` now (renamed from this page): its undismissed
         *  error goes with it. */
        followRename: (from, to) => set((prev) => ({ errors: withErrorsRenamed(prev.errors, from, to) })),

        /** Dismiss workload `name`'s action error: never touches an action in flight. */
        dismissActionError: (name) => set((s) => ({ errors: withoutError(s.errors, name) })),

        ...spec.commands(command),
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

  return { useStore, useStatsStore, useWorkload };
}
