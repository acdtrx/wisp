import * as containerApi from '../api/containers.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';
import { RECORD } from './records.js';
import { createWorkloadStore } from './workloadStore.js';

/** How often the selected container's stats stream samples. */
const STATS_INTERVAL_MS = 3000;

const containers = createWorkloadStore({
  listTopic: TOPIC.CONTAINERS,
  changeKind: CHANGE_KIND.CONTAINER,
  record: RECORD.CONTAINER,
  seed: (item) => ({
    name: item.name,
    uuid: item.uuid ?? null,
    type: 'container',
    image: item.image,
    state: item.state,
    iconId: item.iconId,
    autoBackup: item.autoBackup,
    updateAvailable: item.updateAvailable,
    scheduledRestart: item.scheduledRestart ?? null,
  }),
  /* The list carries the run state, the scheduled restart and the restart-required
   * flag, so a restart done elsewhere drops the badge here. */
  listFields: ['state', 'scheduledRestart', 'pendingRestart'],
  statsUrl: (name) => `/api/containers/${encodeURIComponent(name)}/stats?intervalMs=${STATS_INTERVAL_MS}`,
  commands: ({ job, untilListLeaves }) => ({
    startContainer: (name) => job(name, 'start', () => containerApi.startContainerApi(name)),
    stopContainer: (name) => job(name, 'stop', () => containerApi.stopContainerApi(name)),
    restartContainer: (name) => job(name, 'restart', () => containerApi.restartContainerApi(name)),
    /* Kill (SIGKILL) always ends the task: busy until the list shows it out of `running`. */
    killContainer: (name) => untilListLeaves(name, 'kill', 'running', () => containerApi.killContainerApi(name)),
    deleteContainer: (name, deleteFiles) => job(name, 'delete', () => containerApi.deleteContainerApi(name, deleteFiles)),
  }),
});

/** The containers (`data`: the `containers` topic's list), the container a page shows,
 *  and the container commands. */
export const useContainerStore = containers.useStore;

/** Container `name` as its page shows it: its config record, with the list's live fields over it. */
export const useContainer = containers.useWorkload;

/** The selected container's stats, from its scoped stream. */
export const useContainerStatsStore = containers.useStatsStore;

/** Send a command that changes container `name` and resolve once its new state is shown (workloadStore.js). */
export const runContainerCommand = containers.runCommand;
