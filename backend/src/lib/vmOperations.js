/**
 * Every command that changes a VM (app glue): one purpose-named function per
 * command, with its lock and its follow-ups, which the routes and the MCP
 * tools call. A job takes the VM's operation lock through the job starter
 * (`subject`), for the whole job; an instant command through
 * `withVmOperationLock`, for the call. No route takes a lock itself
 * (docs/specs/BACKUPS.md → Per-VM operation lock).
 *
 * The follow-ups outside the VM's own record — its section assignment and its
 * last backup attempt — are lib/workloadFollowUps.js's, the same as a
 * container's.
 */
import {
  assertVMNameAvailable,
  createVM,
  assertVMState,
  startVM,
  stopVM,
  forceStopVM,
  rebootVM,
  suspendVM,
  resumeVM,
  deleteVM,
  updateVMConfig,
  renameVM,
  attachDisk,
  createAndAttachDisk,
  detachDisk,
  resizeDiskBySlot,
  attachISO,
  ejectISO,
  attachUSBDevice,
  detachUSBDevice,
  createBackup,
  listVMs,
  subscribeVMListChange,
  isShutOff,
  planBackupRestore,
  restoreBackup,
  getVMConfig,
} from './vmManager/index.js';
import {
  startJob,
  titleForVmCreate,
  titleForVmBackup,
  titleForVmStart,
  titleForVmStop,
  titleForVmForceStop,
  titleForVmDelete,
  titleForVmRestore,
} from './jobs/index.js';
import { generateCloudInit, rebuildCloudInitISO, updateCloudInit, detachCloudInitDisk } from './cloudInit.js';
import { isPathInsideAllowedRoots } from './paths.js';
import { withVmOperationLock } from './vmOperationLock.js';
import { createAppError } from './appErrors.js';
import { startWorkloadBackupJob } from './workloadBackup.js';
import { followWorkloadDelete, followWorkloadRename } from './workloadFollowUps.js';
import { assertFirstBootSetupFits, createSpecForProfile } from './vmProfiles.js';
import { JOB_KIND } from '../../../shared/wireNames.js';

const vm = (name) => ({ type: 'vm', name });

// ── Jobs ────────────────────────────────────────────────────────────

/**
 * Create a VM as a job holding the new name's lock. `spec`'s library paths are
 * already resolved and checked (lib/paths.js, in the route). The cloud-init
 * seed ISO and cloud-init.json are built into the directory createVM has just
 * created, so they share its rollback. `done`: `{ name }`.
 */
export function startVmCreateJob({ spec: request, log }) {
  /* The profile's settings, the request's own values over them (lib/vmProfiles.js). */
  if (request.cloudInit) assertFirstBootSetupFits(request.profile, request.name);
  const spec = createSpecForProfile(request);
  const name = spec.name;
  const wantsCloudInit = !!(spec.cloudInit && spec.cloudInit.enabled !== false);
  return startJob({
    kind: JOB_KIND.VM_CREATE,
    title: titleForVmCreate(name),
    subject: vm(name),
    // Free in libvirt and on disk before any artifact is built: cloud-init
    // would otherwise write into an existing VM's directory.
    check: () => assertVMNameAvailable(name),
    log,
    run: async (report) => {
      await createVM(spec, {
        onStep(step, data) {
          report({ step, ...data });
        },
        populateVMDir: wantsCloudInit
          ? async () => {
            report({ step: 'cloudinit' });
            await generateCloudInit(name, spec.cloudInit);
          }
          : undefined,
      });
      return { name };
    },
  });
}

/** Back the VM up (it must be stopped) through the one backup orchestration. `done`: `{ timestamp }`. */
export function startVmBackupJob({ name, destinationIds, log }) {
  return startWorkloadBackupJob({
    kind: JOB_KIND.VM_BACKUP,
    title: titleForVmBackup(name),
    subject: vm(name),
    origin: 'manual',
    destinationIds,
    // Answered in the request; the manager re-checks inside the job.
    check: async () => {
      const found = (await listVMs()).find((v) => v.name === name);
      if (!found) throw createAppError('VM_NOT_FOUND', `VM "${name}" not found`);
      if (!isShutOff(found.stateCode)) {
        throw createAppError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to create a backup`);
      }
    },
    backupOne: (dest, onProgress) => createBackup(name, dest.path, { origin: 'manual', onProgress }),
    log,
  });
}

/** Start the VM as a job (a large VM can outlast a request). `done`: `{ name }`. */
export function startVmStartJob({ name, log }) {
  return startJob({
    kind: JOB_KIND.VM_START,
    title: titleForVmStart(name),
    subject: vm(name),
    check: () => assertVMState(name, 'start'),
    log,
    run: async () => {
      await startVM(name);
      return { name };
    },
  });
}

/** How long a stop waits for the guest to shut down (API-VMS.md). */
const VM_STOP_WAIT_MS = 5 * 60 * 1000;

function isOffIn(list, name) {
  const found = list.find((v) => v.name === name);
  return !found || isShutOff(found.stateCode);
}

/**
 * Watch the VM list for VM `name` being off (shut off, or gone), from now on:
 * set up before the stop's request, so an off that follows it at once is not
 * missed. `wait(ms)` settles once it is off, or fails with VM_STOP_TIMEOUT
 * after `ms`; `end()` stops the watch.
 */
function watchForVmOff(name) {
  const { promise: off, resolve } = Promise.withResolvers();
  const end = subscribeVMListChange((list) => { if (list && isOffIn(list, name)) resolve(); });
  return {
    end,
    async wait(ms) {
      listVMs().then(
        (list) => { if (isOffIn(list, name)) resolve(); },
        () => { /* the list could not be read: its next announcement decides */ },
      );
      let timer;
      const bound = new Promise((_, reject) => {
        timer = setTimeout(() => reject(createAppError(
          'VM_STOP_TIMEOUT',
          `VM "${name}" is not off ${ms / 60000} min after its guest was asked to shut down: it is left as it is`,
        )), ms);
      });
      try {
        await Promise.race([off, bound]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Stop the VM as a job: ask the guest to shut down (ACPI), then wait until the
 * VM is off, whatever turns it off, for VM_STOP_WAIT_MS at most. Shared: a
 * stop while one waits answers its ack. The lock is held only while the
 * request is sent, so a force stop is accepted while the guest shuts down
 * (BACKUPS.md, Per-VM operation lock). `done`: `{ name }`.
 */
export function startVmStopJob({ name, log }) {
  return startJob({
    kind: JOB_KIND.VM_STOP,
    title: titleForVmStop(name),
    subject: vm(name),
    shared: true,
    check: () => assertVMState(name, 'stop'),
    log,
    run: async (report, _signal, releaseLock) => {
      const watch = watchForVmOff(name);
      try {
        try {
          await stopVM(name);
        } catch (err) {
          // Off (or paused) since the check: the wait tells which.
          if (err.code !== 'VM_NOT_RUNNING') throw err;
        }
        releaseLock();
        report({ step: 'shutting-down' });
        await watch.wait(VM_STOP_WAIT_MS);
      } finally {
        watch.end();
      }
      return { name };
    },
  });
}

/** Force-stop the VM as a job (waiting for QEMU to exit). `done`: `{ name }`. */
export function startVmForceStopJob({ name, log }) {
  return startJob({
    kind: JOB_KIND.VM_FORCE_STOP,
    title: titleForVmForceStop(name),
    subject: vm(name),
    check: () => assertVMState(name, 'running'),
    log,
    run: async () => {
      await forceStopVM(name);
      return { name };
    },
  });
}

/** Delete the VM (its disks too when `deleteDisks`) as a job, then its follow-ups. `done`: `{ name }`. */
export function startVmDeleteJob({ name, deleteDisks, log }) {
  return startJob({
    kind: JOB_KIND.VM_DELETE,
    title: titleForVmDelete(name),
    subject: vm(name),
    check: () => assertVMState(name, 'exists'),
    log,
    run: async () => {
      try {
        await deleteVM(name, deleteDisks);
      } catch (err) {
        // The VM is gone even though its folder stayed: its follow-ups still run.
        if (err.code === 'VM_DELETE_INCOMPLETE') await followWorkloadDelete({ type: 'vm', name, log });
        throw err;
      }
      await followWorkloadDelete({ type: 'vm', name, log });
      return { name };
    },
  });
}

/**
 * Restore the backup at `backupPath` as the new VM `newName`, as a job holding
 * the new name's lock. The backup is planned and validated under that lock,
 * before the job exists; a CD-ROM may keep a source outside the new VM's
 * directory only under the paths an attach accepts. Backups hold no cloud-init
 * seed ISO: it is rebuilt from the restored cloud-init.json before the domain
 * is defined. `done`: `{ name }`.
 */
export function startVmRestoreJob({ backupPath, newName, log }) {
  let plan;
  return startJob({
    kind: JOB_KIND.VM_RESTORE,
    title: titleForVmRestore(newName),
    subject: vm(newName),
    check: async () => {
      plan = await planBackupRestore(backupPath, newName, {
        isExternalSourceAllowed: (absPath) => isPathInsideAllowedRoots(absPath, newName),
      });
    },
    log,
    run: async () => {
      const result = await restoreBackup(plan, {
        populateVMDir: (vmDir, { xml }) => rebuildCloudInitISO(newName, vmDir, xml),
      });
      return { name: result?.name ?? newName };
    },
  });
}

// ── Instant commands ────────────────────────────────────────────────

// Reboot, suspend and resume hold the lock only while the request is sent to
// libvirt: the guest's reboot runs on after the answer.

export function requestVmReboot(name) {
  return withVmOperationLock(name, 'reboot', () => rebootVM(name));
}

export function requestVmSuspend(name) {
  return withVmOperationLock(name, 'suspend', () => suspendVM(name));
}

export function requestVmResume(name) {
  return withVmOperationLock(name, 'resume', () => resumeVM(name));
}

/**
 * Apply a configuration edit (`PATCH /api/vms/:name`), a rename included, and
 * its follow-ups. A body `name` other than `name` is a step of its own: the
 * rename and its follow-ups, then the rest under the new name — a failure of
 * the rest leaves the rename, and its follow-ups, standing. Every edit
 * redefines the domain, so each holds the lock; a rename also holds the
 * target name's, so nothing starts, edits or backs up that name while the VM
 * moves to it (the manager reserves its directory too).
 */
export async function editVmConfig({ name, changes, log }) {
  const { name: requestedName, ...rest } = changes;
  const renameTo = requestedName !== undefined && requestedName !== name ? requestedName : null;
  const apply = async () => {
    let current = name;
    if (renameTo) {
      current = (await renameVM(name, renameTo)).name;
      await followWorkloadRename({ type: 'vm', from: name, to: current, log });
      if (Object.keys(rest).length === 0) return;
    }
    await updateVMConfig(current, rest);
  };
  if (!renameTo) {
    await withVmOperationLock(name, 'config edit', apply);
    return;
  }
  await withVmOperationLock(name, 'rename', () => withVmOperationLock(renameTo, 'rename', apply));
}

/** Attach the library image at `absPath` (resolved and checked by the caller) as the disk in `slot`. */
export function attachVmDisk(name, slot, absPath, bus) {
  return withVmOperationLock(name, 'disk change', () => attachDisk(name, slot, absPath, bus));
}

/** Create a new disk of `sizeGB` and attach it in `slot`. */
export function createVmDisk(name, slot, sizeGB, bus) {
  return withVmOperationLock(name, 'disk change', () => createAndAttachDisk(name, slot, sizeGB, bus));
}

export function detachVmDisk(name, slot) {
  return withVmOperationLock(name, 'disk change', () => detachDisk(name, slot));
}

export function resizeVmDisk(name, slot, sizeGB) {
  return withVmOperationLock(name, 'disk change', () => resizeDiskBySlot(name, slot, sizeGB));
}

// CD-ROM and USB changes lock in every VM state: a hot-plug on a running VM
// writes the persistent definition too (LIVE + CONFIG), and the one long
// holder (backup) needs a stopped VM, so a running VM never waits.

/** Insert the ISO at `absPath` (resolved and checked by the caller) into CD-ROM `slot`. */
export function attachVmIso(name, slot, absPath) {
  return withVmOperationLock(name, 'CD-ROM change', () => attachISO(name, slot, absPath));
}

export function ejectVmIso(name, slot) {
  return withVmOperationLock(name, 'CD-ROM change', () => ejectISO(name, slot));
}

export function attachVmUsb(name, vendorId, productId) {
  return withVmOperationLock(name, 'USB change', () => attachUSBDevice(name, vendorId, productId));
}

export function detachVmUsb(name, vendorId, productId) {
  return withVmOperationLock(name, 'USB change', () => detachUSBDevice(name, vendorId, productId));
}

/**
 * Save the VM's cloud-init config: rewrites cloud-init.json and the seed ISO in its
 * directory, and redefines the sde slot. Only for a VM whose profile takes one.
 */
export function saveVmCloudInit(name, config) {
  return withVmOperationLock(name, 'cloud-init change', async () => {
    const { profile } = await getVMConfig(name);
    assertFirstBootSetupFits(profile, name);
    return updateCloudInit(name, config);
  });
}

/** Detach the seed ISO and delete it and cloud-init.json. */
export function removeVmCloudInit(name) {
  return withVmOperationLock(name, 'cloud-init change', () => detachCloudInitDisk(name));
}
