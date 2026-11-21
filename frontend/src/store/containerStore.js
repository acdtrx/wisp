import * as containerApi from '../api/containers.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';
import { RECORD } from './records.js';
import { createWorkloadStore } from './workloadStore.js';

/** How often the selected container's stats stream samples. */
const STATS_INTERVAL_MS = 3000;

/** What a start, stop or restart changes: the config, and the runs (one starts or ends). */
const runsToo = (name) => [[RECORD.CONTAINER, name], [RECORD.CONTAINER_RUNS, name]];

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
  commands: ({ job, icon, untilListLeaves }) => ({
    startContainer: (name) => job(name, 'start', () => containerApi.startContainerApi(name), runsToo(name)),
    stopContainer: (name) => job(name, 'stop', () => containerApi.stopContainerApi(name), runsToo(name)),
    restartContainer: (name) => job(name, 'restart', () => containerApi.restartContainerApi(name), runsToo(name)),
    /* Kill (SIGKILL) always ends the task: busy until the list shows it out of `running`. */
    killContainer: (name) => untilListLeaves(name, 'kill', 'running', () => containerApi.killContainerApi(name)),
    /* A delete's new state is the list without the container: no record to read again. */
    deleteContainer: (name, deleteFiles) => job(name, 'delete', () => containerApi.deleteContainerApi(name, deleteFiles), []),
    /* The header's icon: one of the header's actions, sharing its error slot. */
    setContainerIcon: (name, iconId) => icon(name, () => containerApi.updateContainer(name, { iconId })),
  }),
});

/** The containers (`data`: the `containers` topic's list), the container a page shows,
 *  and the container commands. */
export const useContainerStore = containers.useStore;

/** Container `name` as its page shows it: its config record, with the list's live fields over it. */
export const useContainer = containers.useWorkload;

/** The selected container's stats, from its scoped stream. */
export const useContainerStatsStore = containers.useStatsStore;

/** Send a command that changes container `name`: resolves once its change is on screen. */
export const awaitContainerChange = containers.awaitChange;

