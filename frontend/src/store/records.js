import * as backupsApi from '../api/backups.js';
import * as containersApi from '../api/containers.js';
import * as hostApi from '../api/host.js';
import * as libraryApi from '../api/library.js';
import * as settingsApi from '../api/settings.js';
import * as tokensApi from '../api/authTokens.js';
import * as updatesApi from '../api/updates.js';
import * as vmsApi from '../api/vms.js';
import { CHANGE_KIND, JOB_KIND, TOPIC } from '../../../shared/wireNames.js';
import { createRecordCache } from './recordCache.js';

/** The record kinds (`useRecord(RECORD.X, id)`): client names, not wire names, so none
 *  may spell a hyphenated change kind (the lint refuses those anywhere). */
export const RECORD = Object.freeze({
  VM: 'vm',
  VM_USB: 'vm-usb',
  VM_CLOUD_INIT: 'vm-cloud-init',
  VM_XML: 'vm-xml',
  CONTAINER: 'container',
  CONTAINER_MOUNT_USAGE: 'container-mount-usage',
  CONTAINER_RUNS: 'container-runs',
  MOUNT_FILE_CONTENT: 'mount-file-content',
  SETTINGS: 'settings',
  HOST_MOUNT_STATUS: 'host-mount-status',
  NETWORK_BRIDGES: 'managed-network-bridges',
  HOST_BRIDGES: 'host-bridges',
  LIBRARY: 'library',
  CONTAINER_IMAGES: 'container-images',
  IMAGE_UPDATE_STATUS: 'image-update-status',
  TOKENS: 'tokens',
  WISP_UPDATE: 'wisp-update-status',
  HOST_INFO: 'host-info',
  HOST_HARDWARE: 'host-hardware',
  HOST_GPUS: 'host-gpus',
  OS_UPDATE_PACKAGES: 'os-update-packages',
  VM_BACKUPS: 'vm-backups',
  CONTAINER_BACKUPS: 'container-backups',
});

const VM_GONE = ['VM_NOT_FOUND'];
const CONTAINER_GONE = ['CONTAINER_NOT_FOUND'];

const listed = (list, name) => (Array.isArray(list) ? list.some((w) => w.name === name) : undefined);
const changeOf = (change) => ({ change, byId: true });
const kindChange = (change) => ({ change });

/**
 * The newest finished image update check on the jobs list: a check, whoever started
 * it (this page, another tab, the hourly run), rewrites the status when it ends.
 */
function newestFinishedImageCheck(frame) {
  if (!Array.isArray(frame?.jobs)) return undefined;
  const checks = frame.jobs.filter((j) => j.kind === JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK && j.status !== 'running');
  return checks.sort((a, b) => b.createdAt - a.createdAt)[0]?.jobId ?? null;
}

/**
 * Every record kind, once: how it is read and the cues it is read again on
 * (docs/specs/API.md, `changes` topic payload). Each is also read again when the
 * events stream reconnects.
 */
export const RECORD_KINDS = {
  [RECORD.VM]: {
    fetch: (name, o) => vmsApi.getVM(name, o),
    goneCodes: VM_GONE,
    // A delete sends no `vm` change: the list stops listing it, and the read answers 404.
    cues: [changeOf(CHANGE_KIND.VM), { topic: TOPIC.VMS, key: listed }],
  },
  [RECORD.VM_USB]: { fetch: (name, o) => vmsApi.getVMUSB(name, o), goneCodes: VM_GONE, cues: [changeOf(CHANGE_KIND.VM)] },
  [RECORD.VM_CLOUD_INIT]: { fetch: (name, o) => vmsApi.getCloudInit(name, o), goneCodes: VM_GONE, cues: [changeOf(CHANGE_KIND.VM)] },
  [RECORD.VM_XML]: { fetch: (name, o) => vmsApi.getVMXML(name, o), goneCodes: VM_GONE, cues: [changeOf(CHANGE_KIND.VM)] },
  [RECORD.CONTAINER]: {
    fetch: (name, o) => containersApi.getContainer(name, o),
    goneCodes: CONTAINER_GONE,
    cues: [changeOf(CHANGE_KIND.CONTAINER), { topic: TOPIC.CONTAINERS, key: listed }],
  },
  [RECORD.CONTAINER_MOUNT_USAGE]: {
    fetch: (name, o) => containersApi.getContainerMountUsage(name, o),
    goneCodes: CONTAINER_GONE,
    cues: [changeOf(CHANGE_KIND.CONTAINER)],
  },
  [RECORD.CONTAINER_RUNS]: {
    fetch: (name, o) => containersApi.listContainerRuns(name, o),
    goneCodes: CONTAINER_GONE,
    // A run starts and ends with the container's state, which the list carries.
    cues: [{ topic: TOPIC.CONTAINERS, key: (list, name) => (Array.isArray(list) ? list.find((c) => c.name === name)?.state ?? null : undefined) }],
  },
  /* `[container, mount]`; read while its editor is open, and again on its container's
   * change (the editor follows it by value: a read with the same content leaves its
   * edits). */
  [RECORD.MOUNT_FILE_CONTENT]: {
    fetch: ([container, mount], o) => containersApi.getMountFileContent(container, mount, o),
    goneCodes: ['CONTAINER_MOUNT_NOT_FOUND', 'CONTAINER_NOT_FOUND'],
    cues: [{ change: CHANGE_KIND.CONTAINER, byId: true, idOf: ([container]) => container }],
  },
  [RECORD.SETTINGS]: { singleton: true, fetch: (_, o) => settingsApi.getSettings(o), cues: [kindChange(CHANGE_KIND.SETTINGS)] },
  [RECORD.HOST_MOUNT_STATUS]: { singleton: true, fetch: (_, o) => settingsApi.getMountStatus(o), cues: [kindChange(CHANGE_KIND.HOST_MOUNTS)] },
  [RECORD.NETWORK_BRIDGES]: {
    singleton: true, fetch: (_, o) => hostApi.listManagedNetworkBridges(o), cues: [kindChange(CHANGE_KIND.NETWORK_BRIDGES)],
  },
  /* The bridges a NIC can take: they change when a managed bridge is made or removed. */
  [RECORD.HOST_BRIDGES]: { singleton: true, fetch: (_, o) => vmsApi.getHostBridges(o), cues: [kindChange(CHANGE_KIND.NETWORK_BRIDGES)] },
  [RECORD.LIBRARY]: { singleton: true, fetch: (_, o) => libraryApi.listFiles(o), cues: [kindChange(CHANGE_KIND.LIBRARY)] },
  [RECORD.CONTAINER_IMAGES]: {
    singleton: true, fetch: (_, o) => containersApi.listContainerImages(o), cues: [kindChange(CHANGE_KIND.IMAGES)],
  },
  [RECORD.IMAGE_UPDATE_STATUS]: {
    singleton: true,
    fetch: (_, o) => containersApi.getImageUpdateStatus(o),
    cues: [{ topic: TOPIC.JOBS, key: newestFinishedImageCheck }],
  },
  [RECORD.TOKENS]: { singleton: true, fetch: (_, o) => tokensApi.listApiTokens(o), cues: [kindChange(CHANGE_KIND.TOKENS)] },
  [RECORD.WISP_UPDATE]: { singleton: true, fetch: (_, o) => updatesApi.getUpdateStatus(o), cues: [kindChange(CHANGE_KIND.WISP_UPDATE)] },
  [RECORD.HOST_INFO]: { singleton: true, fetch: (_, o) => hostApi.getHostInfo(o), cues: [] },
  [RECORD.HOST_HARDWARE]: { singleton: true, fetch: (_, o) => hostApi.getHostHardware(o), cues: [] },
  [RECORD.HOST_GPUS]: { singleton: true, fetch: (_, o) => hostApi.getHostGpus(o), cues: [] },
  /* What the last OS update check found: the stats carry when it ran. */
  [RECORD.OS_UPDATE_PACKAGES]: {
    singleton: true,
    fetch: (_, o) => hostApi.listUpgradablePackages(o),
    cues: [{ topic: TOPIC.STATS, key: (stats) => stats?.updatesLastChecked ?? null }],
  },
  /* Every `backups` frame is also the cue that the backup lists changed. */
  [RECORD.VM_BACKUPS]: { singleton: true, fetch: (_, o) => backupsApi.listBackups(o), cues: [{ topic: TOPIC.BACKUPS }] },
  [RECORD.CONTAINER_BACKUPS]: { singleton: true, fetch: (_, o) => backupsApi.listContainerBackups(o), cues: [{ topic: TOPIC.BACKUPS }] },
};

/** The one cache of the records the views show. */
export const records = createRecordCache(RECORD_KINDS);
