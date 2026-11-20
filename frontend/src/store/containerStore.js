import * as containerApi from '../api/containers.js';
import { errorText } from '../api/errors.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';
import { awaitJob } from './backgroundJobsStore.js';
import { createWorkloadStore } from './workloadStore.js';

/** How often the selected container's stats stream samples. */
const STATS_INTERVAL_MS = 3000;

const containers = createWorkloadStore({
  noun: 'container',
  listTopic: TOPIC.CONTAINERS,
  changeKind: CHANGE_KIND.CONTAINER,
  get: (name) => containerApi.getContainer(name),
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
  extend: (set, get, { refreshSelected }) => ({
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
      if (get().imageUpdateCheck.running) return;

      set((prev) => ({
        imageUpdateCheck: { ...prev.imageUpdateCheck, running: true, ref, lastError: null, jobId: null },
      }));

      try {
        const { jobId } = await containerApi.checkContainerImageUpdates(ref);
        set((prev) => ({ imageUpdateCheck: { ...prev.imageUpdateCheck, jobId } }));
        const result = await awaitJob(jobId);
        if (!result) {
          // Cancelled (cut at shutdown): the check ended with nothing to show.
          set((prev) => ({ imageUpdateCheck: { ...prev.imageUpdateCheck, running: false, ref: null, jobId: null } }));
          return;
        }
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
        refreshSelected();
      } catch (err) {
        set((prev) => ({
          imageUpdateCheck: { ...prev.imageUpdateCheck, running: false, ref: null, jobId: null, lastError: errorText(err) },
        }));
      }
    },
  }),
});

/** The containers (`data`: the `containers` topic's list), the selected container's
 *  config, and the container commands. */
export const useContainerStore = containers.useStore;

/** The selected container's stats, from its scoped stream. */
export const useContainerStatsStore = containers.useStatsStore;

/** Send a command that changes container `name` and resolve once its new state is shown (workloadStore.js). */
export const runContainerCommand = containers.runCommand;
