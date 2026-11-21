import { rowId } from '../../hooks/formState.js';
import { randomMac } from '../../utils/randomMac.js';

/**
 * The Create VM panel's draft: the only state of a VM being created. It holds each
 * section's values in that section's own shape (`general`, `advanced`, `nics`, `disks`,
 * `cloudInit`); the sections read and write it, and `createVmBody` turns it into the
 * create request once, at submit.
 */

const noDisk = () => ({ type: 'none', sizeGB: 32, bus: 'virtio', sourcePath: null, sourceName: null, resizeGB: null });

export function defaultVmDraft() {
  return {
    general: { name: '', osType: 'Linux', vcpus: 2, memoryMiB: 2048, autostart: false },
    advanced: {
      firmware: 'uefi',
      machineType: 'q35',
      cpuMode: 'host-passthrough',
      videoDriver: 'virtio',
      graphicsType: 'vnc',
      bootOrder: ['hd', 'cdrom', 'network'],
      bootMenu: true,
      memBalloon: true,
      guestAgent: true,
      vtpm: false,
      virtioRng: true,
      nestedVirt: false,
    },
    nics: [{ id: rowId(), type: 'bridge', source: '', model: 'virtio', mac: '' }],
    disks: { disk: noDisk(), disk2: noDisk(), cdrom1Path: null, cdrom2Path: null, cdrom1Name: null, cdrom2Name: null },
    cloudInit: {
      enabled: true,
      hostname: '',
      username: 'wisp',
      password: '',
      sshKey: '',
      sshKeySource: '',
      growPartition: true,
      packageUpgrade: true,
      installQemuGuestAgent: true,
      installAvahiDaemon: true,
    },
  };
}

/** A new NIC row of the draft. */
export const newDraftNic = (source = '') => ({ id: rowId(), type: 'bridge', mac: randomMac(), source, model: 'virtio' });

/** The draft after the General section's values become `general`: a change of OS type
 *  brings that OS's CPU, RAM, firmware, TPM and disk bus. */
export function withGeneral(draft, general) {
  const next = { ...draft, general };
  if (general.osType === draft.general.osType) return next;
  const windows = general.osType === 'Windows';
  const bus = windows ? 'scsi' : 'virtio';
  next.general = { ...general, vcpus: windows ? 4 : 2, memoryMiB: windows ? 8192 : 2048 };
  next.advanced = { ...draft.advanced, firmware: windows ? 'uefi-secure' : 'uefi', ...(windows ? { vtpm: true } : {}) };
  next.disks = { ...draft.disks, disk: { ...draft.disks.disk, bus }, disk2: { ...draft.disks.disk2, bus } };
  return next;
}

/** Whether the draft's disks take cloud-init (a Linux VM booting an existing image). */
export const takesCloudInit = (draft) => draft.general.osType !== 'Windows'
  && (draft.disks.disk.type === 'existing' || draft.disks.disk2.type === 'existing');

const MIN_MEMORY_MIB = 128;

/**
 * What keeps a VM's CPU and RAM, as typed, from being sent: the server takes a whole
 * number of CPUs from 1, and of MiB from 128. A field cleared is '' (no number). Editing,
 * the form hook keeps those of values the user changed; creating, all stand.
 *
 * @param {{ vcpus: number | '', memoryMiB: number | '' }} general
 * @returns {{ vcpus?: string, memoryMiB?: string }}
 */
export function generalProblems({ vcpus, memoryMiB }) {
  const problems = {};
  if (!Number.isInteger(vcpus) || vcpus < 1) problems.vcpus = 'CPU must be a whole number above 0';
  if (!Number.isInteger(memoryMiB) || memoryMiB < MIN_MEMORY_MIB) problems.memoryMiB = 'RAM must be at least 128 MB';
  return problems;
}

/** What the draft is refused for before it is sent, or null. */
export function draftProblem(draft) {
  if (!draft.general.name.trim()) return 'VM name is required';
  const general = Object.values(generalProblems(draft.general))[0];
  if (general) return general;
  if (draft.disks.disk.type === 'existing' && !draft.disks.disk.sourcePath) return 'Please select an existing disk image';
  if (draft.disks.disk2.type === 'existing' && !draft.disks.disk2.sourcePath) return 'Please select an existing disk image for the second disk';
  return null;
}

const resize = (gb) => (gb != null && gb > 0 ? gb : undefined);

/**
 * The create request for the draft. A NIC with no bridge chosen takes the first host
 * bridge (the one its picker shows selected); an empty cloud-init hostname, the VM's name
 * (its placeholder: what is stored).
 *
 * @param {ReturnType<typeof defaultVmDraft>} draft
 * @param {string[]} bridges — the host's bridges, first the default
 */
export function createVmBody(draft, bridges) {
  const { general: g, advanced: a, nics, disks: { disk, disk2, cdrom1Path, cdrom2Path }, cloudInit: c } = draft;
  return {
    name: g.name.trim(),
    osType: g.osType,
    osVariant: 'generic',
    vcpus: g.vcpus,
    memoryMiB: g.memoryMiB,
    autostart: g.autostart,
    firmware: a.firmware,
    machineType: a.machineType,
    cpuMode: a.cpuMode,
    videoDriver: a.videoDriver,
    graphicsType: a.graphicsType,
    bootOrder: a.bootOrder,
    bootMenu: a.bootMenu,
    memBalloon: a.memBalloon,
    guestAgent: a.guestAgent,
    vtpm: a.vtpm,
    virtioRng: a.virtioRng,
    nestedVirt: a.nestedVirt,
    nics: nics.map((n) => ({
      type: n.type || 'bridge',
      source: n.source || bridges[0] || undefined,
      model: n.model || 'virtio',
      mac: n.mac || undefined,
    })),
    disk: disk.type === 'none'
      ? { type: 'none', bus: disk.bus || 'virtio' }
      : {
          type: disk.type || 'new',
          sizeGB: disk.sizeGB ?? 32,
          bus: disk.bus || 'virtio',
          sourcePath: disk.sourcePath || undefined,
          resizeGB: resize(disk.resizeGB),
        },
    disk2: disk2.type && disk2.type !== 'none'
      ? {
          type: disk2.type,
          sizeGB: disk2.sizeGB ?? 32,
          bus: disk2.bus || 'virtio',
          sourcePath: disk2.type === 'existing' ? disk2.sourcePath : undefined,
          resizeGB: resize(disk2.resizeGB),
        }
      : undefined,
    cdrom1Path: cdrom1Path || undefined,
    cdrom2Path: cdrom2Path || undefined,
    cloudInit: takesCloudInit(draft)
      ? {
          enabled: c.enabled !== false,
          hostname: c.hostname || g.name,
          username: c.username,
          password: c.password,
          sshKey: c.sshKey,
          growPartition: c.growPartition,
          packageUpgrade: c.packageUpgrade,
          installQemuGuestAgent: c.installQemuGuestAgent,
          installAvahiDaemon: c.installAvahiDaemon,
        }
      : undefined,
  };
}
